package com.communityos.api.billing;

import static com.communityos.api.Fixtures.*;
import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.billing.adapter.gateway.RazorpayGateway;
import com.communityos.api.billing.adapter.gateway.SimulatedGateway;
import com.communityos.api.billing.application.CounterSettlement;
import com.communityos.api.billing.application.DueService;
import com.communityos.api.billing.application.GatewaySettlement;
import com.communityos.api.billing.application.LedgerPoster;
import com.communityos.api.billing.application.PaymentService;
import com.communityos.api.billing.application.gateway.GatewayRegistry;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.domain.BillingEvents;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.billing.domain.DueStatus;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.billing.domain.OrderStatus;
import com.communityos.api.billing.domain.PaymentOrder;
import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.http.HttpTransport;
import com.communityos.api.shared.resilience.CircuitBreaker;
import com.communityos.api.shared.resilience.Resilient;
import com.communityos.api.shared.resilience.RetryPolicy;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.BadSignature;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.shared.web.Json;
import java.net.URI;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class BillingTest {
    final Fixtures.Dues dues = new Fixtures.Dues(); final Fixtures.Orders orders = new Fixtures.Orders(); final Fixtures.Payments payments = new Fixtures.Payments();
    final Fixtures.Journals journal = new Fixtures.Journals(); final Fixtures.Audit audit = new Fixtures.Audit(); final Fixtures.Outbox outbox = new Fixtures.Outbox();
    final com.communityos.api.shared.events.DomainEvents events = Fixtures.events(new LedgerPoster(journal, CLOCK).handlers(), outbox);
    final SimulatedGateway sim = new SimulatedGateway("s3cret");
    final GatewaySettlement gatewaySettlement = new GatewaySettlement(dues, payments, events, audit, Tx.direct(), orders, CLOCK);
    final CounterSettlement counter = new CounterSettlement(dues, payments, events, audit, Tx.direct(), dues, CLOCK);
    final Fixtures.Platform platform = new Fixtures.Platform(orders);
    final PaymentService pay = new PaymentService(dues, payments, orders, new GatewayRegistry(List.of(sim), "simulated"), gatewaySettlement, platform, platform, events, Tx.direct(), CLOCK,
        Duration.ofMinutes(30), "INR");
    final DueService dueService = new DueService(dues, dues, dues, events, audit, Tx.direct(), CLOCK);

    // ---- the bill ------------------------------------------------------------------------------------------------------------------------------
    @Test void billComputesTaxAndFollowsItsStateMachine() {
        Due d = due(UNIT_A, BLOCK_1, MAINTENANCE, "3000", LocalDate.of(2026, 10, 10));
        assertEquals(Money.of("540.00"), d.tax()); assertEquals(Money.of("3540"), d.total());
        assertEquals(Money.of("1000"), d.settle(Money.of("1000"), CLOCK.instant()));
        assertEquals(DueStatus.PARTLY_PAID, d.status());
        assertThrows(DomainException.class, () -> d.cancel("raised by mistake", CLOCK.instant()), "a bill with payments cannot be cancelled");
        assertEquals(Money.of("2540"), d.settle(Money.of("5000"), CLOCK.instant()), "only what is owed is applied");
        assertEquals(DueStatus.PAID, d.status()); assertTrue(d.outstanding().isZero());
        assertTrue(d.pullEvents().stream().anyMatch((e) -> e instanceof BillingEvents.DuePaid));
        assertEquals(Money.ZERO, d.settle(Money.of("10"), CLOCK.instant()), "a paid bill takes nothing more");
        assertThrows(DomainException.class, () -> d.waive("goodwill", CLOCK.instant()), "Paid is final");
        Due w = due(UNIT_A, BLOCK_1, MAINTENANCE, "100", LocalDate.of(2026, 10, 10));
        assertThrows(DomainException.class, () -> w.cancel(" ", CLOCK.instant()), "a reason is required");
        w.cancel("raised twice", CLOCK.instant());
        assertEquals(DueStatus.CANCELLED, w.status()); assertEquals(Money.ZERO, w.outstanding());
        assertThrows(DomainException.class, () -> due(UNIT_A, BLOCK_1, MAINTENANCE, "-5", LocalDate.of(2026, 10, 10)));
    }

    @Test void raisingABillPostsABalancedLedgerEntryAndAnOutboxEvent() {
        Due d = dueService.raise(treasurer(), new DueService.RaiseDue(UNIT_A, "Maintenance", LocalDate.of(2026, 10, 1), "October", Money.of("3000"), LocalDate.of(2026, 10, 10)));
        assertEquals("DUE-0001", d.shortId());
        Journal.Entry e = journal.entries.get(0);
        assertEquals(3, e.lines().size());
        assertEquals("1100", e.lines().get(0).accountCode()); assertEquals(Money.of("3540"), e.lines().get(0).debit());
        assertEquals("billing.due.raised", outbox.events.get(0).topic());
        assertThrows(AccessDenied.class, () -> dueService.raise(utilityClerk(), new DueService.RaiseDue(UNIT_A, "Maintenance", null, null, Money.of("1"), LocalDate.of(2026, 10, 10))),
            "a utility clerk cannot raise maintenance bills");
        assertThrows(AccessDenied.class, () -> dueService.raise(owner(UNIT_A), new DueService.RaiseDue(UNIT_A, "Maintenance", null, null, Money.of("1"), LocalDate.of(2026, 10, 10))));
        assertEquals("billing.due.raised", outbox.events.get(outbox.events.size() - 1).topic());
        assertEquals(1, dues.rows.size(), "refused requests saved nothing");
    }

    @Test void aUpiPaymentCarriesThePayersUpiIdAndTheBanksUtr() {
        var o = sim.createOrder(new com.communityos.api.billing.application.gateway.PaymentGateway.OrderRequest("o-1", "r-1", new Money(new java.math.BigDecimal("500.00")), "INR", java.util.Map.of()));
        var r = sim.simulate(o.providerOrderRef(), SimulatedGateway.Outcome.SUCCESS, "asha.m@oksbi");
        assertTrue(r.get("utr").matches("\\d{12}"), "a 12-digit UTR");
        var paid = sim.fetchPayment(r.get("providerPaymentRef"));
        assertEquals("asha.m@oksbi", paid.payerRef()); assertEquals(r.get("utr"), paid.bankRef());
        assertEquals("UPI · asha.m@oksbi · UTR " + r.get("utr"), paid.paidVia(), "kept on the payment for matching the bank statement");
        assertEquals("bad-upi-id", assertThrows(DomainException.RuleViolated.class, () -> sim.simulate(o.providerOrderRef(), SimulatedGateway.Outcome.SUCCESS, "not a upi id")).code());
        var declined = sim.simulate(o.providerOrderRef(), SimulatedGateway.Outcome.FAILURE, "asha.m@oksbi");
        assertNull(declined.get("utr"), "a declined payment has no UTR");
    }

    @Test void lateFeesFollowTheRuleForTheBillOncePerMonth() {
        var json = new com.fasterxml.jackson.databind.ObjectMapper();
        var s = com.communityos.api.billing.domain.LateFees.settings(true, true, null, null, null, null,
            "[{\"appliesTo\":\"Water\",\"kind\":\"Fixed per month\",\"value\":50,\"grace\":5,\"maxMonths\":2},{\"appliesTo\":\"*\",\"kind\":\"Percent per month\",\"value\":2,\"grace\":0}]", json);
        java.time.LocalDate due = java.time.LocalDate.of(2026, 6, 10), asOf = java.time.LocalDate.of(2026, 10, 20);
        java.util.UUID unit = java.util.UUID.randomUUID();
        var water = new com.communityos.api.billing.domain.LateFees.Bill(java.util.UUID.randomUUID(), "D-1", unit, "Water", "Unpaid", new java.math.BigDecimal("800.00"), due, null);
        var maint = new com.communityos.api.billing.domain.LateFees.Bill(java.util.UUID.randomUUID(), "D-2", unit, "Maintenance", "Partly paid", new java.math.BigDecimal("3540.00"), due, null);
        var waived = new com.communityos.api.billing.domain.LateFees.Bill(java.util.UUID.randomUUID(), "D-3", unit, "Maintenance", "Waived", new java.math.BigDecimal("3540.00"), due, null);
        var fee = new com.communityos.api.billing.domain.LateFees.Bill(java.util.UUID.randomUUID(), "D-4", unit, "Late fee", "Unpaid", new java.math.BigDecimal("70.80"), due, null);
        var plan = com.communityos.api.billing.domain.LateFees.plan(java.util.List.of(water, maint, waived, fee), java.util.Set.of(maint.id() + "#1"), s, asOf);
        assertEquals(2, plan.stream().filter((f) -> f.bill() == water).count(), "the water rule caps at 2 months");
        assertTrue(plan.stream().filter((f) -> f.bill() == water).allMatch((f) -> f.amount().compareTo(new java.math.BigDecimal("50.00")) == 0));
        assertEquals(java.util.List.of(2, 3, 4, 5), plan.stream().filter((f) -> f.bill() == maint).map((f) -> f.no()).toList(), "month 1 was charged; 10 Jun -> 20 Oct is five months begun");
        assertEquals(new java.math.BigDecimal("70.80"), plan.stream().filter((f) -> f.bill() == maint).findFirst().orElseThrow().amount(), "2% of the bill");
        assertTrue(plan.stream().noneMatch((f) -> f.bill() == waived || f.bill() == fee), "waived bills and fees earn none");
        assertTrue(com.communityos.api.billing.domain.LateFees.plan(java.util.List.of(water), java.util.Set.of(), s, due.plusDays(5)).isEmpty(), "inside the grace days");
        var old = com.communityos.api.billing.domain.LateFees.settings(true, false, "Fixed per month", new java.math.BigDecimal("100"), new java.math.BigDecimal("0"), null, null, json);
        assertEquals(1, old.rules().size(), "a community with the single older rule keeps it for every bill");
    }
    @Test void staleVersionIsAConflict() {
        Due d = dues.add(due(UNIT_A, BLOCK_1, MAINTENANCE, "100", LocalDate.of(2026, 10, 10)));
        assertThrows(DomainException.Conflict.class, () -> dueService.cancel(treasurer(), d.id(), "duplicate", d.version() + 7));
        dueService.cancel(treasurer(), d.id(), "duplicate", d.version());
        assertEquals(DueStatus.CANCELLED, d.status());
        assertThrows(AccessDenied.NotVisible.class, () -> dueService.cancel(owner(UNIT_B), d.id(), "mine now", d.version()), "another unit's bill looks like it does not exist");
    }

    // ---- paying online ------------------------------------------------------------------------------------------------------------------------
    @Test void serverPricesTheOrderAndTheSameKeyGivesTheSameOrder() {
        Due d1 = dues.add(due(UNIT_A, BLOCK_1, MAINTENANCE, "3000", LocalDate.of(2026, 9, 10)));
        Due d2 = dues.add(due(UNIT_A, BLOCK_1, WATER, "420", LocalDate.of(2026, 10, 10)));
        d1.settle(Money.of("540"), CLOCK.instant());
        Caller c = owner(UNIT_A);
        PaymentService.OrderView v = pay.createOrder(c, new PaymentService.CreateOrder(List.of(d1.id(), d2.id())), "pay-0001-abcd");
        assertEquals(Money.of("3420"), v.order().amount(), "3000 still owed + 420");
        assertEquals(OrderStatus.PENDING, v.order().status());
        assertEquals(v.order().id(), pay.createOrder(c, new PaymentService.CreateOrder(List.of(d1.id(), d2.id())), "pay-0001-abcd").order().id(), "double tap = one order");
        assertThrows(DomainException.class, () -> pay.createOrder(c, new PaymentService.CreateOrder(List.of(d1.id())), "pay-0001-abcd"), "same key, other bills");
        assertThrows(DomainException.class, () -> pay.createOrder(c, new PaymentService.CreateOrder(List.of(d1.id())), null), "a payment needs an idempotency key");
        Due other = dues.add(due(UNIT_B, BLOCK_2, MAINTENANCE, "3000", LocalDate.of(2026, 10, 10)));
        assertThrows(AccessDenied.NotVisible.class, () -> pay.createOrder(c, new PaymentService.CreateOrder(List.of(other.id())), "pay-0002-abcd"), "not my bill");
        assertEquals(1, orders.rows.size());
    }

    @Test void confirmVerifiesSignatureFetchesProviderRecordAndSettlesOnce() {
        Due d1 = dues.add(due(UNIT_A, BLOCK_1, MAINTENANCE, "3000", LocalDate.of(2026, 9, 10)));
        Caller c = owner(UNIT_A);
        PaymentService.OrderView v = pay.createOrder(c, new PaymentService.CreateOrder(List.of(d1.id())), "pay-0003-abcd");
        Map<String, String> paid = sim.simulatePay(v.order().providerOrderRef(), true);
        assertThrows(DomainException.class, () -> pay.confirm(c, v.order().id(), paid.get("providerPaymentRef"), "forged"), "bad signature");
        assertThrows(AccessDenied.NotVisible.class, () -> pay.confirm(owner(UNIT_B), v.order().id(), paid.get("providerPaymentRef"), paid.get("signature")), "someone else's order");
        PaymentRepository.Receipt r = pay.confirm(c, v.order().id(), paid.get("providerPaymentRef"), paid.get("signature"));
        assertEquals(Money.of("3540"), r.amount()); assertEquals(DueStatus.PAID, d1.status()); assertEquals(OrderStatus.PAID, orders.rows.get(v.order().id()).status());
        PaymentRepository.Receipt again = pay.confirm(c, v.order().id(), paid.get("providerPaymentRef"), paid.get("signature"));
        assertEquals(r.id(), again.id(), "confirming twice gives the same receipt");
        assertEquals(1, payments.rows.size());
        Journal.Entry e = journal.entries.get(journal.entries.size() - 1);
        assertEquals("1200", e.lines().get(0).accountCode(), "gateway clearing, not bank, until the settlement arrives");
    }

    @Test void webhookIsSignedDeduplicatedAndRacesWithConfirm() {
        Due d1 = dues.add(due(UNIT_A, BLOCK_1, MAINTENANCE, "3000", LocalDate.of(2026, 9, 10)));
        Caller c = owner(UNIT_A);
        PaymentService.OrderView v = pay.createOrder(c, new PaymentService.CreateOrder(List.of(d1.id())), "pay-0004-abcd");
        Map<String, String> paid = sim.simulatePay(v.order().providerOrderRef(), true);
        byte[] body = ("evt_1,payment.captured," + v.order().providerOrderRef() + "," + paid.get("providerPaymentRef")).getBytes();
        assertThrows(BadSignature.class, () -> pay.webhook("simulated", Map.of("x-simulated-signature", "nope"), body));
        assertEquals(0, payments.rows.size(), "a forged webhook changes nothing");
        Map<String, String> h = Map.of("x-simulated-signature", Crypto.hmacHex("s3cret", body));
        pay.webhook("simulated", h, body);
        pay.webhook("simulated", h, body);
        assertEquals(1, payments.rows.size(), "delivered twice, recorded once");
        assertEquals(DueStatus.PAID, d1.status());
        pay.confirm(c, v.order().id(), paid.get("providerPaymentRef"), paid.get("signature"));
        assertEquals(1, payments.rows.size(), "the app's confirm afterwards finds the receipt");
    }

    @Test void racingInsertReturnsTheWinnersReceipt() {
        Due d1 = dues.add(due(UNIT_A, BLOCK_1, MAINTENANCE, "100", LocalDate.of(2026, 9, 10)));
        Caller c = owner(UNIT_A);
        PaymentService.OrderView v = pay.createOrder(c, new PaymentService.CreateOrder(List.of(d1.id())), "pay-0005-abcd");
        Map<String, String> paid = sim.simulatePay(v.order().providerOrderRef(), true);
        payments.simulateRace = true;
        assertEquals("RCP-RACE", pay.confirm(c, v.order().id(), paid.get("providerPaymentRef"), paid.get("signature")).receiptNo());
    }

    @Test void failedPaymentMarksTheOrderAndReconcileExpiresStaleOnes() {
        Due d1 = dues.add(due(UNIT_A, BLOCK_1, MAINTENANCE, "100", LocalDate.of(2026, 9, 10)));
        PaymentService.OrderView v = pay.createOrder(owner(UNIT_A), new PaymentService.CreateOrder(List.of(d1.id())), "pay-0006-abcd");
        Map<String, String> failed = sim.simulatePay(v.order().providerOrderRef(), false);
        byte[] body = ("evt_9,payment.failed," + v.order().providerOrderRef() + "," + failed.get("providerPaymentRef")).getBytes();
        pay.webhook("simulated", Map.of("x-simulated-signature", Crypto.hmacHex("s3cret", body)), body);
        assertEquals(OrderStatus.FAILED, orders.rows.get(v.order().id()).status());
        assertEquals(DueStatus.UNPAID, d1.status());
        assertTrue(outbox.events.stream().anyMatch((e) -> e.topic().equals("billing.payment-order.failed")));
        Due d2 = dues.add(due(UNIT_A, BLOCK_1, MAINTENANCE, "100", LocalDate.of(2026, 9, 10)));
        PaymentService stale = new PaymentService(dues, payments, orders, new GatewayRegistry(List.of(sim), "simulated"), gatewaySettlement, platform, platform, events, Tx.direct(),
            java.time.Clock.offset(CLOCK, Duration.ofHours(2)), Duration.ofMinutes(30), "INR");
        PaymentService.OrderView v2 = pay.createOrder(owner(UNIT_A), new PaymentService.CreateOrder(List.of(d2.id())), "pay-0007-abcd");
        stale.reconcile(10);
        assertEquals(OrderStatus.EXPIRED, orders.rows.get(v2.order().id()).status());
    }

    // ---- at the office ---------------------------------------------------------------------------------------------------------------------------
    @Test void counterReceiptPaysOldestFirstAndKeepsTheRestAsCredit() {
        Due older = dues.add(due(UNIT_A, BLOCK_1, WATER, "500", LocalDate.of(2026, 8, 10)));
        Due newer = dues.add(due(UNIT_A, BLOCK_1, WATER, "500", LocalDate.of(2026, 9, 10)));
        PaymentRepository.Receipt r = counter.settle(treasurer(), new CounterSettlement.Request(UNIT_A, Money.of("1200"), "Cash", null, null, "desk"));
        assertEquals(DueStatus.PAID, older.status()); assertEquals(DueStatus.PAID, newer.status());
        assertEquals(Money.of("200"), r.toCredit()); assertEquals(1, payments.credits.size());
        Journal.Entry e = journal.entries.get(journal.entries.size() - 1);
        assertEquals("1000", e.lines().get(0).accountCode()); assertEquals(Money.of("1200"), e.lines().get(0).debit());
        assertEquals(Money.of("200"), e.lines().get(2).credit(), "advance from member");
        assertThrows(AccessDenied.class, () -> counter.settle(owner(UNIT_A), new CounterSettlement.Request(UNIT_A, Money.of("1"), "Cash", null, null, null)), "residents cannot write receipts");
        assertThrows(DomainException.class, () -> counter.settle(treasurer(), new CounterSettlement.Request(UNIT_A, Money.of("1"), "Bitcoin", null, null, null)));
        assertThrows(DomainException.class, () -> counter.settle(treasurer(), new CounterSettlement.Request(UNIT_A, Money.of("1"), "Cash", LocalDate.of(2027, 1, 1), null, null)), "future date");
        Caller blockTwo = caller(Caller.Category.Staff, java.util.Set.of("accountant"), java.util.Set.of(), java.util.Set.of(BLOCK_2), com.communityos.api.shared.security.Permission.MANAGE_DUES);
        assertThrows(AccessDenied.class, () -> counter.settle(blockTwo, new CounterSettlement.Request(UNIT_A, Money.of("1"), "Cash", null, null, null)), "outside my blocks");
    }

    @Test void journalRefusesAnUnbalancedEntry() {
        assertThrows(IllegalStateException.class, () -> new Journal.Entry(LocalDate.now(), "x", "manual", null,
            List.of(Journal.Line.debit("1000", null, Money.of("10"), "a"), Journal.Line.credit("4000", null, Money.of("9"), "b"))));
        assertThrows(IllegalArgumentException.class, () -> new Journal.Line("1000", null, null, Money.of("1"), Money.of("1"), "both sides"));
    }

    @Test void orderPricingRefusesClosedAndMixedBills() {
        Due a = due(UNIT_A, BLOCK_1, MAINTENANCE, "10", LocalDate.of(2026, 9, 10)), b = due(UNIT_B, BLOCK_2, MAINTENANCE, "10", LocalDate.of(2026, 9, 10));
        assertThrows(DomainException.class, () -> PaymentOrder.price(COMMUNITY, UNIT_A, owner(UNIT_A).membership(), List.of(a, b), "INR", "simulated", "k", CLOCK.instant()));
        a.cancel("mistake", CLOCK.instant());
        assertThrows(DomainException.class, () -> PaymentOrder.price(COMMUNITY, UNIT_A, owner(UNIT_A).membership(), List.of(a), "INR", "simulated", "k", CLOCK.instant()));
    }

    // ---- Razorpay adapter -------------------------------------------------------------------------------------------------------------------------
    @Test void razorpaySignaturesAmountsAndRetries() {
        List<HttpTransport.Request> calls = new ArrayList<>();
        int[] failFirst = {1};
        HttpTransport http = (req) -> {
            calls.add(req);
            if (failFirst[0]-- > 0) return new HttpTransport.Response(502, Map.of(), new byte[0]);
            if (req.uri().getPath().equals("/v1/orders")) return new HttpTransport.Response(200, Map.of(), "{\"id\":\"order_ABC123\"}".getBytes());
            return new HttpTransport.Response(200, Map.of(), "{\"id\":\"pay_XYZ789\",\"order_id\":\"order_ABC123\",\"amount\":354000,\"currency\":\"INR\",\"status\":\"captured\",\"method\":\"card\"}".getBytes());
        };
        Resilient r = new Resilient(Duration.ZERO, new CircuitBreaker("rzp", 5, Duration.ofSeconds(30), CLOCK), RetryPolicy.transientFailures(3), (d) -> {});
        RazorpayGateway g = new RazorpayGateway(http, r, new RazorpayGateway.Settings(URI.create("https://api.razorpay.com"), "rzp_key", "key_secret", "hook_secret"), Json.mapper());
        var o = g.createOrder(new com.communityos.api.billing.application.gateway.PaymentGateway.OrderRequest("8c0e-order", "ORD-1", Money.of("3540"), "INR", Map.of()));
        assertEquals("order_ABC123", o.providerOrderRef());
        assertEquals(2, calls.size(), "one 502, then retried");
        assertTrue(new String(calls.get(1).body()).contains("\"amount\":354000"), "paise");
        assertEquals("8c0e-order", calls.get(1).headers().get("X-Idempotency-Key"));
        assertFalse(o.checkout().toString().contains("key_secret"), "no secret to the app");
        var p = g.fetchPayment("pay_XYZ789");
        assertEquals(Money.of("3540"), p.amount()); assertTrue(p.captured());
        assertTrue(g.verifyCheckout("order_ABC123", "pay_XYZ789", Crypto.hmacHex("key_secret", "order_ABC123|pay_XYZ789")));
        assertFalse(g.verifyCheckout("order_ABC123", "pay_OTHER1", Crypto.hmacHex("key_secret", "order_ABC123|pay_XYZ789")));
        byte[] hook = "{\"event\":\"payment.captured\",\"payload\":{\"payment\":{\"entity\":{\"id\":\"pay_XYZ789\",\"order_id\":\"order_ABC123\"}}}}".getBytes();
        var ev = g.readWebhook(Map.of("x-razorpay-signature", Crypto.hmacHex("hook_secret", hook), "x-razorpay-event-id", "evt_1"), hook);
        assertEquals("pay_XYZ789", ev.get().providerPaymentRef());
        assertThrows(BadSignature.class, () -> g.readWebhook(Map.of("x-razorpay-signature", Crypto.hmacHex("key_secret", hook)), hook));
        assertThrows(DomainException.class, () -> g.fetchPayment("../../v1/refunds"), "path injection");
    }
}
