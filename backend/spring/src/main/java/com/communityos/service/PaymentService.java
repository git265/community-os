package com.communityos.service;

import com.communityos.access.CommunityMeta;
import com.communityos.access.CommunityMetaLoader;
import com.communityos.adapter.payment.SimulatedPaymentProvider;
import com.communityos.config.AppProperties;
import com.communityos.outbox.EventOutbox;
import com.communityos.payments.CircuitBreaker;
import com.communityos.payments.FinanceSettlement;
import com.communityos.payments.PaymentOrder;
import com.communityos.payments.PaymentStore;
import com.communityos.port.DocumentRepository;
import com.communityos.port.PaymentProvider;
import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.communityos.service.audit.AuditTrail;
import com.communityos.web.BadRequestException;
import com.communityos.web.ConflictException;
import com.communityos.web.NotFoundException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;

/**
 * Online payments, settled by the SERVER. The order is priced here (never from the browser); the provider's signed webhook, or the reconcile
 * job when a webhook was lost, settles it: bills, credit used, payment-ledger line, receipt and the `payment.settled` outbox event are written
 * in ONE REPEATABLE READ transaction, with the order row locked and automatic retry on a serialization conflict (SQLSTATE 40001 / 40P01).
 * Port of contract-server/payments.mjs; the tests of that file are the specification.
 *
 * Late fees that built up are added at pay time when the screen asks (`includeLateFees`: the server adds them as their own bills, then they are paid
 * with the bill), and the payer's unit is told "Payment received" after a bill is settled (best effort: a failed message never undoes a payment).
 *
 * Not ported yet (see docs/BACKEND.md section 10): a payer who owns several units can pay for the first one only.
 */
@Service
public class PaymentService {
    private static final Logger log = LoggerFactory.getLogger(PaymentService.class);
    private static final Set<String> PURPOSES = Set.of("due", "donation", "booking");
    private static final Set<String> CLOSED = Set.of("Paid", "Cancelled");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final PaymentStore store;
    private final PaymentProvider provider;
    private final AppProperties.Payments cfg;
    private final SecureRecordService records;
    private final DocumentRepository repo;
    private final CommunityMetaLoader metas;
    private final FinanceSettlement finance;
    private final EventOutbox outbox;
    private final AuditTrail audit;
    private final CircuitBreaker breaker;
    private final Tx tx;
    private final ObjectMapper json;
    private final Clock clock;
    private final com.communityos.finance.LateFees lateFees;
    private final com.communityos.notify.Notifier notifier;
    private final java.time.ZoneId zone = java.time.ZoneId.systemDefault();   // the community's calendar day decides whether a late fee is due
    private volatile long lastReconcile;
    private volatile boolean warnedNoLookup;

    public PaymentService(PaymentStore store, PaymentProvider provider, AppProperties props, SecureRecordService records, DocumentRepository repo, CommunityMetaLoader metas,
                          FinanceSettlement finance, EventOutbox outbox, AuditTrail audit, CircuitBreaker breaker, Tx tx, ObjectMapper json, Clock clock) {
        this.store = store; this.provider = provider; this.cfg = props.payments(); this.records = records; this.repo = repo; this.metas = metas;
        this.finance = finance; this.outbox = outbox; this.audit = audit; this.breaker = breaker; this.tx = tx; this.json = json; this.clock = clock;
        com.communityos.finance.SystemWriter writer = new com.communityos.finance.SystemWriter(repo, audit, json, clock, finance.constants());
        this.lateFees = new com.communityos.finance.LateFees(writer);
        this.notifier = new com.communityos.notify.Notifier(writer);
    }

    // ---- who may do what ------------------------------------------------------------------------------------------------

    /** Every unit the payer has (payments.mjs unitsOf): an owner of two villas pays the bills of either, whichever one they are signed in for. */
    static Set<String> unitsOf(Principal p) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        if (!p.unit().isEmpty()) out.add(p.unit());
        for (String u : p.units()) if (u != null && !u.isEmpty()) out.add(u);
        return out;
    }

    private static boolean isFinance(Principal p) { return "EC".equals(p.category()) || p.has("MANAGE_DUES") || p.has("MANAGE_LEDGER"); }

    private static String text(JsonNode n, String key) { return Js.str(Js.f(n, key)); }

    private static BigDecimal r2(double n) { return BigDecimal.valueOf(n).setScale(2, RoundingMode.HALF_UP); }

    private static String rid(String prefix) {
        byte[] b = new byte[8]; RANDOM.nextBytes(b);
        StringBuilder sb = new StringBuilder(prefix).append('_');
        for (byte x : b) sb.append(String.format("%02X", x));
        return sb.toString();
    }

    // ---- 1. create (and price) an order ---------------------------------------------------------------------------------

    public JsonNode createOrder(String tenant, Authentication who, JsonNode req) {
        Principal p = records.principal(tenant, who);
        String purpose = text(req, "purpose");
        if (!PURPOSES.contains(purpose)) throw new BadRequestException("Unknown payment purpose.");
        try {
            return tx.run(() -> createInTx(tenant, p, purpose, req));
        } catch (DuplicateKeyException twoAtOnce) {   // two clicks at the same instant: the first committed, so the second now finds its order
            return tx.run(() -> createInTx(tenant, p, purpose, req));
        }
    }

    private JsonNode createInTx(String tenant, Principal p, String purpose, JsonNode req) {
        List<String> refs = new ArrayList<>(new LinkedHashSet<>(strings(req.path("refs"))));
        double gross = 0, credit = 0;
        String unit = "";
        ObjectNode meta = json.createObjectNode().put("description", clip(text(req, "description"), 200));
        BigDecimal amount;
        if ("due".equals(purpose)) {
            if (refs.isEmpty()) throw new BadRequestException("Choose the bills to pay.");
            double feesToAdd = 0;
            if (Js.truthy(Js.f(req, "includeLateFees"))) feesToAdd = includeLateFees(tenant, p, refs, Js.truthy(Js.f(req, "quote")));
            List<JsonNode> dues = new ArrayList<>();
            for (String id : refs) repo.get(tenant, "dues", id).ifPresent(dues::add);
            if (dues.size() != refs.size()) throw new NotFoundException("One of these bills does not exist.");
            unit = text(dues.get(0), "unit");
            for (JsonNode d : dues) if (!text(d, "unit").equals(unit)) throw new BadRequestException("Pay one unit's bills at a time.");
            if (!unitsOf(p).contains(unit) && !isFinance(p)) throw new org.springframework.security.access.AccessDeniedException("You can only pay your own unit's bills.");
            double total = 0; int open = 0;
            for (JsonNode d : dues) if (!CLOSED.contains(text(d, "status"))) { open++; total += Js.number(d, "amount"); }
            if (open == 0) throw new ConflictException("These bills are already paid.", null);
            total = FinanceSettlement.r2(total + feesToAdd);
            if (Js.truthy(Js.f(req.path("meta"), "useCredit"))) credit = Math.min(total, Math.max(0, FinanceSettlement.creditBalance(repo.list(tenant, "unitCredits"), unit)));
            gross = total;
            amount = r2(total - credit);
            meta.put("useCredit", credit > 0).put("credit", credit).put("gross", total);
            if (amount.signum() <= 0) throw new BadRequestException("Your unit credit covers these bills; use the credit instead of paying online.");
        } else if ("donation".equals(purpose)) {
            JsonNode don = refs.isEmpty() ? null : repo.get(tenant, "culturalDonations", refs.get(0)).orElse(null);
            if (don == null) throw new NotFoundException("Pledge not found.");
            if ("Received".equals(text(don, "status"))) throw new ConflictException("This pledge is already received.", null);
            amount = r2(Js.number(don, "amount")); unit = text(don, "unit");
            if (!unit.isEmpty() && !unitsOf(p).contains(unit) && !isFinance(p)) throw new org.springframework.security.access.AccessDeniedException("This pledge belongs to another unit.");
            gross = amount.doubleValue();
        } else {
            amount = r2(Js.number(req, "amount")); unit = text(req, "unit");
            if (amount.signum() <= 0) throw new BadRequestException("Nothing to pay.");
            if (!unitsOf(p).contains(unit) && !isFinance(p)) throw new org.springframework.security.access.AccessDeniedException("You can only pay for your own unit.");
            // money already taken for this booking but never used (the payer closed the page, the booking was refused): hand it back instead of charging twice
            Optional<PaymentOrder> prior = store.unusedPaidBooking(tenant, unit, amount, p.userId());
            if (prior.isPresent()) return view(prior.get());
            gross = amount.doubleValue();
        }
        if (Js.truthy(Js.f(req, "quote"))) {   // a price check: nothing is written
            ObjectNode q = json.createObjectNode().put("quote", true).put("amount", amount.doubleValue()).put("currency", "INR").put("gross", gross).put("credit", credit)
                    .put("extra", FinanceSettlement.r2(amount.doubleValue() - gross + credit));
            q.set("refs", json.valueToTree(refs));
            return q;
        }
        List<String> sorted = new ArrayList<>(refs); java.util.Collections.sort(sorted);
        String key = purpose + ":" + String.join(",", sorted) + ":" + FinanceSettlement.show(amount.doubleValue()) + ":" + p.userId();
        Optional<PaymentOrder> found = store.lockOpenByKey(tenant, key);
        if (found.isPresent()) return view(found.get());   // asked twice (double click, retry after a timeout): the same order comes back
        boolean paid = store.paidWithKey(tenant, key);
        if (paid && !"booking".equals(purpose)) throw new ConflictException("This payment has already been made.", null);

        String id = rid("ORD");
        String currency = clip(Js.truthy(Js.f(req, "currency")) ? text(req, "currency") : "INR", 3);
        PaymentProvider.ProviderOrder po;
        try {
            po = breaker.call(() -> provider.createOrder(amount.movePointRight(2).setScale(0, RoundingMode.HALF_UP).longValueExact(), currency, id, Map.of("tenant", tenant, "purpose", purpose)));
        } catch (RuntimeException e) { throw e; } catch (Exception e) { throw new IllegalStateException("The payment provider refused the order: " + e.getMessage(), e); }
        meta.put("publicKey", po.publicKey());
        Instant now = clock.instant();
        PaymentOrder o = new PaymentOrder(id, tenant, purpose, refs, unit, p.name(), p.userId(), amount, currency, "Created", paid ? null : key, meta, provider.id(), po.providerOrderId(),
                null, null, null, null, null, 0, now, now, null);
        store.insert(o);
        return view(o);
    }

    /**
     * A late fee that has built up on the asked bills is added now, by the server, and paid with the bill: each overdue bill gets its fee bills
     * (applyLateFees for that one bill), then every unpaid fee bill of the asked bills joins `refs`. Only for the payer's own unit, or the finance team.
     * A price check (quote) writes nothing: the fees it would add are counted instead (the returned refs then name only fee bills that already exist).
     * @return the amount of fees a quote would add (0 when they were really added)
     */
    private double includeLateFees(String tenant, Principal p, List<String> refs, boolean quote) {
        List<JsonNode> asked = new ArrayList<>();
        for (String id : refs) repo.get(tenant, "dues", id).ifPresent(asked::add);
        if (asked.isEmpty() || !(unitsOf(p).contains(text(asked.get(0), "unit")) || isFinance(p))) return 0;
        String today = com.communityos.finance.FinDates.today(clock, zone);
        double pending = 0;
        if (quote) {
            List<JsonNode> fin = repo.list(tenant, "financeSettings");
            com.communityos.finance.LateFees.Settings s = com.communityos.finance.LateFees.settings(fin.isEmpty() ? json.createObjectNode() : fin.get(0), json);
            List<JsonNode> all = repo.list(tenant, "dues");
            for (com.communityos.finance.LateFees.Planned pl : com.communityos.finance.LateFees.plan(all, s, today))
                for (JsonNode d : asked) if (!Js.truthy(d, "lateFeeFor") && Js.strictEq(Js.f(pl.due(), "id"), Js.f(d, "id"))) pending += pl.amount();
        } else {
            for (JsonNode d : asked) if (!Js.truthy(d, "lateFeeFor")) lateFees.apply(tenant, today, FinanceSettlement.SYSTEM, false, text(d, "id"));
        }
        for (JsonNode f : repo.list(tenant, "dues")) {
            String id = text(f, "id"), of = Js.text(f, "lateFeeFor");
            if (of != null && refs.contains(of) && !refs.contains(id) && !CLOSED.contains(text(f, "status"))) refs.add(id);
        }
        return pending;
    }

    /** "Payment received" to the unit, after the settlement committed. Best effort: a failed message is logged, the payment stands. */
    private void receipt(String tenant, Map<String, Object> outcome, String paymentId) {
        if (!Boolean.TRUE.equals(outcome.get("settled")) || !(outcome.get("order") instanceof ObjectNode order) || !"due".equals(text(order, "purpose"))) return;
        try {
            String unit = text(order, "unit");
            tx.run(() -> notifier.notify(tenant, new com.communityos.notify.Notifier.Item("payment_made", "Payment received · " + unit,
                    Js.toStr(Js.f(order, "settled")) + " bill(s) paid online. Reference " + paymentId + ".").link("#/billing").toUnit(json.getNodeFactory().textNode(unit)).by(FinanceSettlement.SYSTEM)));
        } catch (RuntimeException e) { log.warn("payment receipt message failed for {}: {}", text(order, "orderId"), e.toString()); }
    }

    public JsonNode getOrder(String tenant, Authentication who, String orderId) {
        Principal p = records.principal(tenant, who);
        PaymentOrder o = store.get(tenant, orderId).orElseThrow(() -> new NotFoundException("No such payment."));
        if (!o.payerId().equals(p.userId()) && !unitsOf(p).contains(o.unit()) && !isFinance(p)) throw new NotFoundException("No such payment.");
        return view(o);
    }

    JsonNode view(PaymentOrder o) {
        ObjectNode v = json.createObjectNode();
        v.put("orderId", o.orderId()).put("id", o.orderId()).put("status", o.status()).put("amount", o.amount().doubleValue()).put("currency", o.currency()).put("purpose", o.purpose());
        v.set("refs", json.valueToTree(o.refs()));
        v.put("unit", o.unit()).put("payer", o.payer()).put("method", o.method() == null ? "" : o.method()).put("paymentId", o.paymentId() == null ? "" : o.paymentId())
                .put("description", text(o.meta(), "description")).put("createdAt", o.createdAt().toString());
        if (o.paidAt() == null) v.putNull("paidAt"); else v.put("paidAt", o.paidAt().toString());
        v.put("note", o.note() == null ? "" : o.note()).put("provider", o.provider()).put("providerOrderId", o.providerRef() == null ? "" : o.providerRef()).put("publicKey", text(o.meta(), "publicKey"));
        return v;
    }

    // ---- 2. settle: bill + ledger + receipt + outbox event, all or nothing ---------------------------------------------------

    record SettleEvent(BigDecimal amount, String paymentId, String method) {}

    /** MUST run inside a REPEATABLE READ transaction (see `settleOrder`). The order row is locked first, so two settlements of one order queue up. */
    private Map<String, Object> settleLocked(String tenant, String orderId, SettleEvent ev) {
        Map<String, Object> out = new LinkedHashMap<>();
        PaymentOrder o = store.lock(tenant, orderId).orElse(null);
        if (o == null) { out.put("ok", false); out.put("reason", "Unknown order"); return out; }
        if ("Paid".equals(o.status())) { out.put("ok", true); out.put("duplicate", true); out.put("order", view(o)); return out; }
        if (ev.amount() == null || ev.amount().subtract(o.amount()).abs().compareTo(new BigDecimal("0.009")) > 0) {   // the bank took a different amount than we asked for: a person must look
            String reported = ev.amount() == null ? "no amount" : ev.amount().stripTrailingZeros().toPlainString();
            store.markFailed(orderId, "Amount mismatch: asked " + o.amount().stripTrailingZeros().toPlainString() + ", provider reports " + reported + ". Not settled - check with the provider.");
            audit.write(tenant, audit.entry(new Principal("system", new Principal.Role("system", FinanceSettlement.SYSTEM, "System", Set.of()), FinanceSettlement.SYSTEM, "", List.of()),
                    "Online payments", "payments", orderId, "", o.unit(), "Update", "Order " + orderId + ": provider reported " + reported + ", expected " + o.amount().stripTrailingZeros().toPlainString() + " - not settled", null));
            out.put("ok", false); out.put("reason", "Amount mismatch"); return out;
        }
        CommunityMeta meta = metas.of(tenant);
        ObjectNode order = (ObjectNode) view(o);
        String method = ev.method() == null || ev.method().isEmpty() ? null : ev.method();
        if ("due".equals(o.purpose())) {
            List<JsonNode> paid = finance.settleDues(tenant, meta, o.refs(), o.unit(), Js.truthy(Js.f(o.meta(), "useCredit")), method == null ? "Online" : method, ev.paymentId(), o.payer());
            for (JsonNode d : paid) finance.syncDuePayment(tenant, meta, d, FinanceSettlement.SYSTEM);   // the ledger entry is part of the same transaction
            order.put("settled", paid.size());
        } else if ("donation".equals(o.purpose()) && !o.refs().isEmpty()) {
            finance.receiveDonation(tenant, o.refs().get(0), ev.paymentId(), o.payer());
        }
        store.markPaid(orderId, ev.paymentId(), method == null ? "" : method);
        ObjectNode payload = json.createObjectNode().put("orderId", orderId).put("paymentId", ev.paymentId()).put("purpose", o.purpose()).put("unit", o.unit())
                .put("amount", o.amount().doubleValue()).put("payer", o.payer());
        outbox.emit(tenant, "payment.settled", payload);   // same transaction: saved together or not at all
        out.put("ok", true); out.put("order", order); out.put("settled", true);
        return out;
    }

    private Map<String, Object> settleOrder(String tenant, String orderId, SettleEvent ev) {
        Map<String, Object> out = tx.repeatableRead(() -> settleLocked(tenant, orderId, ev));
        receipt(tenant, out, ev.paymentId());
        return out;
    }

    // ---- 3. the provider's webhook (no sign-in: the signature is the credential) ----------------------------------------------

    /** Called by the provider. Idempotent per event id: the event is recorded in the SAME transaction as what it settles, so a failure lets the provider's retry run again. */
    public Map<String, Object> webhook(String raw, Map<String, String> headers) {
        if (!provider.verifyWebhook(raw, headers)) throw new WebhookSignatureException();
        PaymentProvider.WebhookEvent ev;
        try { ev = provider.parseWebhook(raw); } catch (RuntimeException e) { throw new BadRequestException("Bad event."); }
        if (ev.eventId().isBlank() || (ev.orderId().isBlank() && ev.providerOrderId().isBlank()) || ev.type().isBlank()) throw new BadRequestException("Bad event.");
        PaymentOrder o = (!ev.orderId().isBlank() ? store.find(ev.orderId()) : store.findByProviderRef(ev.providerOrderId())).orElse(null);
        if (o == null) return Map.of("ok", false, "reason", "Unknown order");
        if ("Paid".equals(ev.status())) {
            Map<String, Object> out = tx.repeatableRead(() -> {
                if (!store.recordEvent(ev.eventId(), o.orderId(), ev.type())) return Map.<String, Object>of("ok", true, "duplicate", true);
                return settleLocked(o.tenant(), o.orderId(), new SettleEvent(ev.amount(), ev.paymentId(), ev.method()));
            });
            receipt(o.tenant(), out, ev.paymentId());
            return out;
        }
        return tx.run(() -> {
            if (!store.recordEvent(ev.eventId(), o.orderId(), ev.type())) return Map.<String, Object>of("ok", true, "duplicate", true);
            store.moveOpen(o.orderId(), ev.status(), ev.method() == null || ev.method().isEmpty() ? null : ev.method(), null);
            return Map.<String, Object>of("ok", true);
        });
    }

    // ---- 4. the pretend bank (development only) ------------------------------------------------------------------------

    public Map<String, Object> simulate(String tenant, Authentication who, String orderId, JsonNode req) {
        if (!(provider instanceof SimulatedPaymentProvider sim) || !cfg.allowSimulated()) throw new NotFoundException("Not found.");
        JsonNode o = getOrder(tenant, who, orderId);
        String outcome = text(req, "outcome");
        if (!Set.of("success", "failure", "pending").contains(outcome)) throw new BadRequestException("Choose success, failure or pending.");
        String method = Js.truthy(Js.f(req, "method")) ? text(req, "method") : "Card";
        boolean deliver = !req.has("deliverWebhook") || Js.truthy(Js.f(req, "deliverWebhook"));
        String paymentId = rid("PAY");
        store.recordBank(orderId, json.createObjectNode().put("outcome", outcome).put("method", method).put("paymentId", paymentId).put("at", clock.instant().toString()));
        Map<String, Object> out = new LinkedHashMap<>();
        if (!deliver) { out.put("delivered", false); out.put("order", o); return out; }   // "the webhook got lost": only the reconcile job can finish this one
        String type = "success".equals(outcome) ? "payment.captured" : "failure".equals(outcome) ? "payment.failed" : "payment.pending";
        String raw = json.createObjectNode().put("id", rid("EVT")).put("type", type).put("orderId", orderId).put("paymentId", paymentId).put("amount", o.path("amount").asDouble())
                .put("currency", o.path("currency").asText()).put("method", method).put("at", clock.instant().toString()).toString();
        out.put("delivered", true);
        out.put("result", webhook(raw, Map.of("x-signature", sim.sign(raw))));
        return out;
    }

    // ---- 5. reconcile: finish what the webhook did not -------------------------------------------------------------------------

    @Scheduled(fixedDelay = 5000, initialDelay = 15000)
    public void tick() {
        if (cfg.reconcileSeconds() <= 0 || clock.millis() - lastReconcile < cfg.reconcileSeconds() * 1000L) return;
        lastReconcile = clock.millis();
        try { reconcile(); } catch (RuntimeException e) { log.error("payment reconcile failed: {}", e.getMessage()); }
    }

    private Optional<PaymentProvider.ProviderStatus> providerStatus(PaymentOrder o) throws Exception {
        Optional<PaymentProvider.ProviderStatus> s = breaker.call(() -> provider.lookup(o));   // bounded by a timeout, and cut off quickly when the provider is down
        if (s.isEmpty() && !"simulated".equals(o.provider()) && !warnedNoLookup) {
            warnedNoLookup = true;
            log.warn("provider \"{}\" gave no status for an open order; orders stay pending until its webhook arrives (implement PaymentProvider.lookup).", o.provider());
        }
        return s;
    }

    /** One pass over orders still open and not looked at for a while. Safe to run on several instances at once (the order row lock decides). */
    public Map<String, Integer> reconcile() {
        List<PaymentOrder> open = store.openNotTouchedFor(cfg.pendingRecheckSeconds(), 200);
        int settled = 0, failed = 0, expired = 0;
        for (PaymentOrder o : open) {
            try {
                Optional<PaymentProvider.ProviderStatus> s = providerStatus(o);
                if (s.isPresent() && "success".equals(s.get().outcome())) {
                    Map<String, Object> r = settleOrder(o.tenant(), o.orderId(), new SettleEvent(o.amount(), s.get().paymentId(), s.get().method()));
                    if (Boolean.TRUE.equals(r.get("ok")) && r.get("duplicate") == null) settled++;
                } else if (s.isPresent() && "failure".equals(s.get().outcome())) {
                    tx.run(() -> store.moveOpen(o.orderId(), "Failed", s.get().method() == null || s.get().method().isEmpty() ? null : s.get().method(), null));
                    failed++;
                } else if (Duration.between(o.createdAt(), clock.instant()).toMinutes() >= cfg.orderMinutes()) {
                    tx.run(() -> store.moveOpen(o.orderId(), "Expired", null, "No payment was received in time."));
                    expired++;
                } else tx.run(() -> store.touch(o.orderId()));
            } catch (Exception e) {
                log.error("reconcile failed for {}: {}", o.orderId(), e.getMessage());
            }
        }
        Map<String, Integer> done = new LinkedHashMap<>();
        done.put("checked", open.size()); done.put("settled", settled); done.put("failed", failed); done.put("expired", expired);
        return done;
    }

    // ---- 6. a booking paid online must point at a real, unused, big-enough payment ---------------------------------------------------

    /** @return "" when the payment is now this booking's, else the reason it cannot be used */
    public String claimForBooking(String tenant, String ref, String unit, BigDecimal amount, String bookingId) {
        return new com.communityos.payments.BookingPaymentClaims(store, tx).claimForBooking(tenant, ref, unit, amount, bookingId);
    }

    // ---- refunds (finance only) --------------------------------------------------------------------------------------------

    public Map<String, Object> refund(String tenant, Authentication who, JsonNode req) {
        Principal p = records.principal(tenant, who);
        if (!isFinance(p)) throw new org.springframework.security.access.AccessDeniedException("Only the finance team can refund a payment.");
        BigDecimal amount = new BigDecimal(Js.truthy(Js.f(req, "amount")) ? text(req, "amount") : "0");
        if (amount.signum() <= 0) throw new BadRequestException("Enter a refund amount.");
        var r = provider.refund(text(req, "paymentId"), amount.movePointRight(2).longValue(), text(req, "reason"));
        Map<String, Object> out = new HashMap<>();
        out.put("refundId", r.refundId()); out.put("status", r.status());
        return out;
    }

    // ---- small helpers -------------------------------------------------------------------------------------------------------

    private static List<String> strings(JsonNode arr) {
        List<String> out = new ArrayList<>();
        if (arr != null && arr.isArray()) arr.forEach(x -> out.add(Js.str(x)));
        return out;
    }

    private static String clip(String s, int n) { return s.length() > n ? s.substring(0, n) : s; }

    /** 401: the signature on a provider event did not match. */
    public static class WebhookSignatureException extends RuntimeException {
        public WebhookSignatureException() { super("Bad signature - event ignored."); }
    }
}
