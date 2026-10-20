package com.communityos.payments;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.communityos.access.CommunityMetaLoader;
import com.communityos.access.PrincipalResolver;
import com.communityos.access.ServerHooks;
import com.communityos.adapter.payment.SimulatedPaymentProvider;
import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.config.AppProperties;
import com.communityos.outbox.EventOutbox;
import com.communityos.outbox.InMemoryEventOutboxStore;
import com.communityos.outbox.OutboxEvent;
import com.communityos.outbox.OutboxTopicHandler;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.security.WriteRules;
import com.communityos.service.PaymentService;
import com.communityos.service.PaymentService.WebhookSignatureException;
import com.communityos.service.SecureRecordService;
import com.communityos.service.Tx;
import com.communityos.service.audit.AuditTrail;
import com.communityos.web.ConflictException;
import com.communityos.web.NotFoundException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * Settlement, end to end, with no Spring context and no database. The cases are those of contract-server/test/payments.test.mjs.
 * What this cannot show: PostgreSQL's row locks and REPEATABLE READ (the in-memory profile serialises the money steps with one monitor instead).
 */
class PaymentServiceTest {
    static final String C = "la-paloma";
    final ObjectMapper json = new ObjectMapper();
    final DocumentRepository repo = new InMemoryDocumentRepository();
    final MutableClock clock = new MutableClock(Instant.parse("2026-10-19T12:00:00Z"));
    final InMemoryPaymentStore store = new InMemoryPaymentStore(clock);
    final InMemoryEventOutboxStore events = new InMemoryEventOutboxStore(clock);
    final SimulatedPaymentProvider provider = new SimulatedPaymentProvider("dev-secret");
    final List<OutboxEvent> delivered = new ArrayList<>();
    PaymentService pay;
    EventOutbox outbox;

    static class MutableClock extends Clock {
        Instant now;
        MutableClock(Instant now) { this.now = now; }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId z) { return this; }
        @Override public Instant instant() { return now; }
    }

    PaymentServiceTest() throws Exception { build(2); }

    void build(int maxAttempts) throws Exception {
        AppProperties props = new AppProperties(new AppProperties.Storage("memory", List.of("communities"), false), null, null,
                new AppProperties.Payments("simulated", "dev-secret", 30, 30, 0, true, 8000, 5, 30000), null,
                new AppProperties.Security("jwt", null, "community", "subject,phone,email", "refuse", 0L), null, null,
                new AppProperties.Outbox(true, 5000, maxAttempts, 50, null), new AppProperties.Idempotency(true, 24), null, null);
        Constants constants = Constants.load(json);
        CommunityMetaLoader metas = new CommunityMetaLoader(repo, json, constants, clock, props);
        Tx tx = Tx.none();
        AuditTrail audit = new AuditTrail(repo, json, clock);
        SecureRecordService records = new SecureRecordService(repo, metas, new PrincipalResolver(props, repo), new WriteRules(constants), new ServerHooks(props), audit, tx, json, clock, constants, props, new FinanceSettlement(repo, audit, json, clock, constants), null,
                new com.communityos.evoting.InMemoryEVotingState(), com.communityos.evoting.RandomSource.secure());
        outbox = new EventOutbox(events, tx, props, json, List.of(new OutboxTopicHandler() {
            @Override public String topic() { return "payment.settled"; }
            @Override public void handle(OutboxEvent e) { delivered.add(e); }
        }));
        pay = new PaymentService(store, provider, props, records, repo, metas, new FinanceSettlement(repo, audit, json, clock, constants), outbox, audit,
                new CircuitBreaker("provider", 8000, 5, 30000), tx, json, clock);
        seed();
    }

    JsonNode j(String s) throws Exception { return json.readTree(s); }

    void seed() throws Exception {
        repo.upsert(C, "users", "u-asha", j("{\"id\":\"u-asha\",\"name\":\"Asha\",\"roleId\":\"owner\",\"units\":[\"A-101\"],\"email\":\"asha@x.in\"}"));
        repo.upsert(C, "users", "u-ravi", j("{\"id\":\"u-ravi\",\"name\":\"Ravi\",\"roleId\":\"owner\",\"units\":[\"B-201\"],\"email\":\"ravi@x.in\"}"));
        repo.upsert(C, "users", "u-tre", j("{\"id\":\"u-tre\",\"name\":\"Tara\",\"roleId\":\"treasurer\",\"email\":\"tara@x.in\"}"));
        due("d1", "A-101", 1000, "DUE-0001");
        due("d2", "B-201", 2000, "DUE-0002");
    }

    void due(String id, String unit, double amount, String shortId) throws Exception {
        repo.upsert(C, "dues", id, j("{\"id\":\"" + id + "\",\"unit\":\"" + unit + "\",\"amount\":" + amount + ",\"status\":\"Unpaid\",\"category\":\"Maintenance\",\"dueDate\":\"2026-10-01\",\"shortId\":\""
                + shortId + "\",\"recVersion\":1}"));
    }

    static Authentication as(String email) {
        return new JwtAuthenticationToken(Jwt.withTokenValue("t").header("alg", "none").claim("sub", "sub-" + email).claim("email", email).build());
    }

    JsonNode order(String email, String body) throws Exception { return pay.createOrder(C, as(email), j(body)); }

    JsonNode dueRow(String id) { return repo.get(C, "dues", id).orElseThrow(); }

    Map<String, Object> simulate(String email, String orderId, String body) throws Exception { return pay.simulate(C, as(email), orderId, j(body)); }

    // ---- creating an order -----------------------------------------------------------------------------------------------

    @Test
    void theServerPricesTheOrderAndIgnoresTheAmountTheBrowserSends() throws Exception {
        JsonNode o = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"],\"amount\":1,\"unit\":\"B-201\"}");
        assertEquals(1000.0, o.get("amount").asDouble());
        assertEquals("A-101", o.get("unit").asText());
        assertEquals("Created", o.get("status").asText());
    }

    @Test
    void askingTwiceReturnsTheSameOrder() throws Exception {
        JsonNode a = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"]}");
        JsonNode b = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"]}");
        assertEquals(a.get("orderId").asText(), b.get("orderId").asText());
    }

    @Test
    void nobodyCanPayOrLookUpAnotherUnitsOrder() throws Exception {
        assertThrows(AccessDeniedException.class, () -> order("ravi@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"]}"));
        JsonNode mine = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"]}");
        assertThrows(NotFoundException.class, () -> pay.getOrder(C, as("ravi@x.in"), mine.get("orderId").asText()));
        assertEquals("Created", pay.getOrder(C, as("asha@x.in"), mine.get("orderId").asText()).get("status").asText());
        assertEquals("Created", pay.getOrder(C, as("tara@x.in"), mine.get("orderId").asText()).get("status").asText());   // the finance team can see it
    }

    @Test
    void aPayerWithSeveralUnitsPaysTheBillsOfEachOfThem() throws Exception {
        repo.upsert(C, "users", "u-meena", j("{\"id\":\"u-meena\",\"name\":\"Meena\",\"roleId\":\"owner\",\"units\":[\"A-101\",\"C-7\"],\"email\":\"meena@x.in\"}"));
        due("d7", "C-7", 700, "DUE-0007");
        JsonNode second = order("meena@x.in", "{\"purpose\":\"due\",\"refs\":[\"d7\"]}");   // not the first unit on her record
        assertEquals("C-7", second.get("unit").asText());
        assertEquals(700.0, second.get("amount").asDouble());
        assertEquals("A-101", order("meena@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"]}").get("unit").asText());
        assertEquals("Created", pay.getOrder(C, as("meena@x.in"), second.get("orderId").asText()).get("status").asText());
        assertThrows(AccessDeniedException.class, () -> order("meena@x.in", "{\"purpose\":\"due\",\"refs\":[\"d2\"]}"));   // B-201 is not hers
    }

    @Test
    void aPriceCheckWritesNothing() throws Exception {
        JsonNode q = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"],\"quote\":true}");
        assertTrue(q.get("quote").asBoolean());
        assertEquals(1000.0, q.get("amount").asDouble());
        assertTrue(store.openNotTouchedFor(0, 10).isEmpty());
    }

    // ---- settling ----------------------------------------------------------------------------------------------------------

    @Test
    void aVerifiedWebhookSettlesBillLedgerAndReceiptTogetherAndOnlyOnce() throws Exception {
        String id = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"]}").get("orderId").asText();
        Map<String, Object> sim = simulate("asha@x.in", id, "{\"outcome\":\"success\",\"method\":\"UPI\"}");
        assertEquals(true, sim.get("delivered"));
        JsonNode d = dueRow("d1");
        assertEquals("Paid", d.get("status").asText());
        assertTrue(d.get("receiptNo").asText().startsWith("RCT-"));
        assertEquals("UPI", d.get("paymentMode").asText());
        assertEquals(2, d.get("recVersion").asInt());
        assertTrue(d.get("timeline").size() > 0);
        List<JsonNode> ledger = repo.list(C, "ledger");
        assertEquals(1, ledger.size());
        assertEquals("due:d1", ledger.get(0).get("sourceId").asText());
        assertEquals("Credit", ledger.get(0).get("type").asText());
        assertEquals(1000.0, ledger.get(0).get("amount").asDouble());
        assertEquals("Maintenance", ledger.get(0).get("account").asText());
        JsonNode st = pay.getOrder(C, as("asha@x.in"), id);
        assertEquals("Paid", st.get("status").asText());
        assertFalse(st.get("paymentId").asText().isEmpty());
        assertTrue(repo.list(C, "audit").stream().anyMatch(a -> a.get("who").asText().contains("payment gateway")), "someone is accountable for the settlement");

        // the provider repeats the event, and a second capture arrives for the same order: nothing happens twice
        String raw = "{\"id\":\"EVT-REPEAT\",\"type\":\"payment.captured\",\"orderId\":\"" + id + "\",\"paymentId\":\"PAY-1\",\"amount\":1000,\"method\":\"UPI\"}";
        Map<String, String> sig = Map.of("x-signature", provider.sign(raw));
        assertEquals(true, pay.webhook(raw, sig).get("ok"));
        assertEquals(true, pay.webhook(raw, sig).get("duplicate"));
        assertEquals(1, repo.list(C, "ledger").size());
        assertEquals(2, dueRow("d1").get("recVersion").asInt());
    }

    @Test
    void theSettledEventReachesTheOutboxInTheSameTransaction() throws Exception {
        String id = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"]}").get("orderId").asText();
        simulate("asha@x.in", id, "{\"outcome\":\"success\"}");
        assertEquals(1L, (long) events.counts().get("Pending"));
        EventOutbox.Result r = outbox.dispatch(10);
        assertEquals(1, r.sent());
        assertEquals(1, delivered.size());
        assertEquals(id, delivered.get(0).payload().get("orderId").asText());
        assertEquals("A-101", delivered.get(0).payload().get("unit").asText());
        assertEquals(0, outbox.dispatch(10).sent());
    }

    @Test
    void aForgedEventIsRefusedAndSettlesNothing() throws Exception {
        String id = order("ravi@x.in", "{\"purpose\":\"due\",\"refs\":[\"d2\"]}").get("orderId").asText();
        String raw = "{\"id\":\"EVT-FORGED\",\"type\":\"payment.captured\",\"orderId\":\"" + id + "\",\"paymentId\":\"PAY-X\",\"amount\":2000,\"method\":\"Card\"}";
        assertThrows(WebhookSignatureException.class, () -> pay.webhook(raw, Map.of("x-signature", "00")));
        assertThrows(WebhookSignatureException.class, () -> pay.webhook(raw, Map.of()));
        assertEquals("Unpaid", dueRow("d2").get("status").asText());
    }

    @Test
    void aDifferentAmountThanTheOrderIsNeverSettled() throws Exception {
        String id = order("ravi@x.in", "{\"purpose\":\"due\",\"refs\":[\"d2\"]}").get("orderId").asText();
        String raw = "{\"id\":\"EVT-SHORT\",\"type\":\"payment.captured\",\"orderId\":\"" + id + "\",\"paymentId\":\"PAY-SHORT\",\"amount\":5,\"method\":\"Card\"}";
        Map<String, Object> r = pay.webhook(raw, Map.of("x-signature", provider.sign(raw)));
        assertEquals(false, r.get("ok"));
        assertEquals("Unpaid", dueRow("d2").get("status").asText());
        JsonNode st = pay.getOrder(C, as("ravi@x.in"), id);
        assertEquals("Failed", st.get("status").asText());
        assertTrue(st.get("note").asText().contains("Amount mismatch"));
        assertTrue(repo.list(C, "ledger").isEmpty());
    }

    @Test
    void aDeclinedPaymentLeavesTheBillOpenAndThePayerCanTryAgain() throws Exception {
        String o1 = order("ravi@x.in", "{\"purpose\":\"due\",\"refs\":[\"d2\"]}").get("orderId").asText();
        simulate("ravi@x.in", o1, "{\"outcome\":\"failure\"}");
        assertEquals("Failed", pay.getOrder(C, as("ravi@x.in"), o1).get("status").asText());
        assertEquals("Unpaid", dueRow("d2").get("status").asText());
        String o2 = order("ravi@x.in", "{\"purpose\":\"due\",\"refs\":[\"d2\"]}").get("orderId").asText();
        assertNotEquals(o1, o2);
        simulate("ravi@x.in", o2, "{\"outcome\":\"success\"}");
        assertEquals("Paid", dueRow("d2").get("status").asText());
        assertThrows(ConflictException.class, () -> order("ravi@x.in", "{\"purpose\":\"due\",\"refs\":[\"d2\"]}"));   // already paid
    }

    @Test
    void twoCapturesAtTheSameMomentSettleOnce() throws Exception {
        String id = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"]}").get("orderId").asText();
        int n = 8;
        CountDownLatch go = new CountDownLatch(1);
        AtomicInteger settled = new AtomicInteger(), failures = new AtomicInteger();
        List<Thread> ts = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            String raw = "{\"id\":\"EVT-" + i + "\",\"type\":\"payment.captured\",\"orderId\":\"" + id + "\",\"paymentId\":\"PAY-" + i + "\",\"amount\":1000,\"method\":\"Card\"}";
            Thread t = new Thread(() -> {
                try { go.await(); Map<String, Object> r = pay.webhook(raw, Map.of("x-signature", provider.sign(raw))); if (r.get("settled") != null) settled.incrementAndGet(); }
                catch (Exception e) { failures.incrementAndGet(); }
            });
            ts.add(t); t.start();
        }
        go.countDown();
        for (Thread t : ts) t.join();
        assertEquals(0, failures.get());
        assertEquals(1, settled.get());
        assertEquals(1, repo.list(C, "ledger").size());
        assertEquals(1L, (long) events.counts().get("Pending"));
    }

    // ---- the lost webhook, expiry ------------------------------------------------------------------------------------------

    @Test
    void theBankTookTheMoneyButTheWebhookWasLostSoTheReconcileJobSettlesIt() throws Exception {
        String id = order("ravi@x.in", "{\"purpose\":\"due\",\"refs\":[\"d2\"]}").get("orderId").asText();
        assertEquals(false, simulate("ravi@x.in", id, "{\"outcome\":\"success\",\"deliverWebhook\":false}").get("delivered"));
        assertEquals("Created", pay.getOrder(C, as("ravi@x.in"), id).get("status").asText());   // for a moment the app still says it is waiting
        Map<String, Integer> done = pay.reconcile();
        assertEquals(1, (int) done.get("settled"));
        assertEquals("Paid", pay.getOrder(C, as("ravi@x.in"), id).get("status").asText());
        assertEquals("Paid", dueRow("d2").get("status").asText());
        assertEquals(1, repo.list(C, "ledger").size());
        assertEquals(0, (int) pay.reconcile().get("settled"));   // a second pass changes nothing
    }

    @Test
    void anOrderNobodyPaysExpiresAndAnExpiredOrderLeavesTheBillOpen() throws Exception {
        String id = order("ravi@x.in", "{\"purpose\":\"due\",\"refs\":[\"d2\"]}").get("orderId").asText();
        assertEquals(0, (int) pay.reconcile().get("expired"));   // looked at, still young
        clock.now = clock.now.plusSeconds(2 * 3600);
        assertEquals(1, (int) pay.reconcile().get("expired"));
        assertEquals("Expired", pay.getOrder(C, as("ravi@x.in"), id).get("status").asText());
        assertEquals("Unpaid", dueRow("d2").get("status").asText());
    }

    // ---- unit credit, donations, bookings ---------------------------------------------------------------------------------

    @Test
    void unitCreditIsUsedFirstAndOnlyTheRestIsCharged() throws Exception {
        repo.upsert(C, "unitCredits", "c1", j("{\"id\":\"c1\",\"unit\":\"A-101\",\"type\":\"Credit\",\"kind\":\"Advance\",\"amount\":400,\"date\":\"2026-10-01\"}"));
        JsonNode o = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"],\"meta\":{\"useCredit\":true}}");
        assertEquals(600.0, o.get("amount").asDouble());
        simulate("asha@x.in", o.get("orderId").asText(), "{\"outcome\":\"success\"}");
        JsonNode d = dueRow("d1");
        assertEquals("Paid", d.get("status").asText());
        assertEquals(400.0, d.get("creditApplied").asDouble());
        assertEquals(1000.0, d.get("grossAmount").asDouble());
        assertEquals(600.0, d.get("amount").asDouble());
        assertTrue(repo.list(C, "unitCredits").stream().anyMatch(c -> "Debit".equals(c.get("type").asText()) && c.get("amount").asDouble() == 400.0));
    }

    @Test
    void aPledgePaidOnlineIsReceivedWithAReceiptAndTheEventTotalsFollow() throws Exception {
        repo.upsert(C, "culturalEvents", "e1", j("{\"id\":\"e1\",\"name\":\"Vinayaka Chavithi\",\"startDate\":\"2026-09-14\"}"));
        repo.upsert(C, "culturalDonations", "p1", j("{\"id\":\"p1\",\"eventId\":\"e1\",\"unit\":\"A-101\",\"donor\":\"Asha\",\"amount\":500,\"status\":\"Pledged\"}"));
        JsonNode o = order("asha@x.in", "{\"purpose\":\"donation\",\"refs\":[\"p1\"]}");
        assertEquals(500.0, o.get("amount").asDouble());
        simulate("asha@x.in", o.get("orderId").asText(), "{\"outcome\":\"success\"}");
        JsonNode p = repo.get(C, "culturalDonations", "p1").orElseThrow();
        assertEquals("Received", p.get("status").asText());
        assertEquals("VC26-0001", p.get("receiptNo").asText());
        assertEquals(500.0, repo.get(C, "culturalEvents", "e1").orElseThrow().get("collected").asDouble());
        assertThrows(ConflictException.class, () -> order("asha@x.in", "{\"purpose\":\"donation\",\"refs\":[\"p1\"]}"));
    }

    @Test
    void aPaymentBuysOneBooking() throws Exception {
        JsonNode o = order("asha@x.in", "{\"purpose\":\"booking\",\"unit\":\"A-101\",\"amount\":750}");
        simulate("asha@x.in", o.get("orderId").asText(), "{\"outcome\":\"success\"}");
        String ref = pay.getOrder(C, as("asha@x.in"), o.get("orderId").asText()).get("paymentId").asText();
        assertEquals("", pay.claimForBooking(C, ref, "A-101", new java.math.BigDecimal("750"), "bk-1"));
        assertEquals("", pay.claimForBooking(C, ref, "A-101", new java.math.BigDecimal("750"), "bk-1"));   // the same booking again is fine
        assertTrue(pay.claimForBooking(C, ref, "A-101", new java.math.BigDecimal("750"), "bk-2").contains("already been used"));
        assertTrue(pay.claimForBooking(C, ref, "B-201", new java.math.BigDecimal("750"), "bk-3").contains("another unit"));
        assertTrue(pay.claimForBooking(C, "PAY-NOPE", "A-101", new java.math.BigDecimal("750"), "bk-4").contains("not found"));
        // money taken and never used comes back instead of charging twice
        JsonNode again = order("asha@x.in", "{\"purpose\":\"booking\",\"unit\":\"A-101\",\"amount\":900}");
        simulate("asha@x.in", again.get("orderId").asText(), "{\"outcome\":\"success\"}");
        assertEquals(again.get("orderId").asText(), order("asha@x.in", "{\"purpose\":\"booking\",\"unit\":\"A-101\",\"amount\":900}").get("orderId").asText());
    }

    // ---- the outbox ------------------------------------------------------------------------------------------------------------

    @Test
    void aFailingHandlerIsRetriedWithBackOffThenParkedAsDead() throws Exception {
        List<OutboxEvent> seen = new ArrayList<>();
        AppProperties props = new AppProperties(null, null, null, null, null, null, null, null, new AppProperties.Outbox(true, 5000, 3, 50, null), null, null, null);
        EventOutbox box = new EventOutbox(events, Tx.none(), props, json, List.of(new OutboxTopicHandler() {
            @Override public String topic() { return "x.y"; }
            @Override public void handle(OutboxEvent e) throws Exception { seen.add(e); throw new Exception("mail server down"); }
        }));
        box.emit(C, "x.y", j("{\"a\":1}"));
        assertEquals(1, box.dispatch(10).retried());
        assertEquals(0, box.dispatch(10).retried());   // not due yet: it waits for the back-off
        clock.now = clock.now.plusSeconds(11);
        assertEquals(1, box.dispatch(10).retried());
        clock.now = clock.now.plusSeconds(25);
        EventOutbox.Result last = box.dispatch(10);
        assertEquals(1, last.dead());
        assertEquals(3, seen.size());
        assertEquals("Dead", events.statusOf(1));
        assertTrue(events.errorOf(1).contains("mail server down"));
        assertEquals(0, box.dispatch(10).dead());
        assertEquals(10L, EventOutbox.backoffSeconds(1));
        assertEquals(40L, EventOutbox.backoffSeconds(3));
        assertEquals(3600L, EventOutbox.backoffSeconds(30));
    }

    @Test
    void refundsAreForTheFinanceTeamOnly() throws Exception {
        assertThrows(AccessDeniedException.class, () -> pay.refund(C, as("asha@x.in"), j("{\"paymentId\":\"PAY-1\",\"amount\":10}")));
        assertEquals("Processed", pay.refund(C, as("tara@x.in"), j("{\"paymentId\":\"PAY-1\",\"amount\":10}")).get("status"));
    }

    // ---- late fees at pay time and the receipt message (round 75) ----------------------------------------------------------

    @Test
    void lateFeesThatBuiltUpAreAddedByTheServerAndPaidWithTheBill() throws Exception {
        repo.upsert(C, "financeSettings", "fs", j("{\"id\":\"fs\",\"lateFeeEnabled\":true,\"lateFeeRules\":\"[{\\\"appliesTo\\\":\\\"*\\\",\\\"kind\\\":\\\"Fixed per month\\\",\\\"value\\\":100,\\\"grace\\\":5}]\"}"));
        JsonNode q = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"],\"includeLateFees\":true,\"quote\":true}");
        assertEquals(1100.0, q.get("amount").asDouble(), "the price check counts the fee of one overdue month");
        assertEquals(2, repo.list(C, "dues").size(), "and writes nothing");
        JsonNode o = order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"],\"includeLateFees\":true}");
        assertEquals(1100.0, o.get("amount").asDouble());
        assertEquals(2, o.get("refs").size(), "the bill and its new late-fee bill");
        JsonNode fee = repo.list(C, "dues").stream().filter(d -> "d1".equals(d.path("lateFeeFor").asText())).findFirst().orElseThrow();
        assertEquals("Late fee", fee.path("category").asText());
        assertEquals("System · payment gateway", fee.path("recordCreatedBy").asText());
        assertEquals(1, order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"],\"includeLateFees\":true}").get("refs").size() - 1, "asking again adds no second fee");
        simulate("asha@x.in", o.get("orderId").asText(), "{\"outcome\":\"success\"}");
        assertEquals("Paid", dueRow("d1").path("status").asText());
        assertEquals("Paid", dueRow(fee.path("id").asText()).path("status").asText());
        JsonNode note = repo.list(C, "notifications").stream().filter(n -> "payment_made".equals(n.path("event").asText())).findFirst().orElseThrow();
        assertEquals("Payment received · A-101", note.path("title").asText());
        assertEquals("A-101", note.path("toUnit").asText());
        assertTrue(note.path("body").asText().startsWith("2 bill(s) paid online. Reference PAY_"));
    }

    @Test
    void withoutTheAskTheBillIsPricedAsItIs() throws Exception {
        repo.upsert(C, "financeSettings", "fs", j("{\"id\":\"fs\",\"lateFeeEnabled\":true,\"lateFeeValue\":100,\"lateFeeKind\":\"Fixed per month\"}"));
        assertEquals(1000.0, order("asha@x.in", "{\"purpose\":\"due\",\"refs\":[\"d1\"]}").get("amount").asDouble());
        assertEquals(2, repo.list(C, "dues").size());
    }
}
