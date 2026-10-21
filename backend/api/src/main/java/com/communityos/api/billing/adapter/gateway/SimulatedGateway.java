package com.communityos.api.billing.adapter.gateway;

import com.communityos.api.billing.application.gateway.PaymentGateway;
import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.BadSignature;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * A provider for development and tests (cos.payments.simulated.enabled=true; refused in prod): orders live in memory, the "checkout"
 * signature is HMAC(secret, order|payment) exactly like Razorpay's, so the same app code path is exercised. `simulate` plays the customer and
 * the bank, with what a real bank does:
 *   SUCCESS  charged at once; the app confirms, and the provider's webhook follows (the server records it once)
 *   FAILURE  declined at once; only the webhook tells the server (the order becomes Failed)
 *   PENDING  the bank is slow: charged after `pendingDelay`, then the webhook settles it (the app keeps checking meanwhile)
 *   LOST     charged, but the app's confirmation never arrives (closed tab, lost network): the webhook settles it after `lostDelay`
 * A payer who closes the checkout page makes no payment at all: the order simply expires. Webhooks are delivered by whoever calls
 * `dueWebhooks` (the dev job in Jobs, or a test) through the real webhook endpoint code, signature and all.
 *
 * The payment service itself can be made slow (every call takes `slowLatency`) or down (every call fails), to try the retries, time-outs and
 * the circuit breaker the server puts around a provider (`Resilient`, as for Razorpay). Refunds are "pending" when asked for and processed (or,
 * with refunds set to fail, refused by the bank) after `refundDelay`, reported by webhook like a real provider.
 */
public final class SimulatedGateway implements PaymentGateway {
    public enum Outcome { SUCCESS, FAILURE, PENDING, LOST }
    /** How the payment service answers: normally, slowly, or not at all. */
    public enum Service { NORMAL, SLOW, DOWN }
    /** The bank's settings now (changed at run time from the dev endpoint). */
    public record Mode(Service service, boolean refundsFail) {}
    /** How long each kind of wait takes (cos.payments.simulated.* in application-dev.yml). */
    public record Delays(Duration pending, Duration lost, Duration refund, Duration slowLatency) {
        public static final Delays DEFAULT = new Delays(Duration.ofSeconds(30), Duration.ofSeconds(20), Duration.ofSeconds(60), Duration.ofSeconds(5));
    }
    private record Rfd(String ref, String paymentRef, Money amount, Instant doneAt, boolean fails) {}
    private final Map<String, Rfd> refunds = new ConcurrentHashMap<>();
    private volatile Mode mode = new Mode(Service.NORMAL, false);
    private final com.communityos.api.shared.resilience.Resilient resilient;
    private record Sim(String orderRef, Money amount, String currency) {}
    /** A payment as the bank sees it: charged from `capturedAt` (null: never), or declined. */
    private record Pay(String ref, String orderRef, Money amount, String currency, Instant capturedAt, boolean failed, String reason) {}
    private record Hook(Instant at, String body) {}
    private final Map<String, Sim> orders = new ConcurrentHashMap<>();
    private final Map<String, Pay> payments = new ConcurrentHashMap<>();
    private final ConcurrentLinkedQueue<Hook> hooks = new ConcurrentLinkedQueue<>();
    private final String secret; private final Clock clock; private final Delays delays;

    public SimulatedGateway(String secret) { this(secret, Clock.systemUTC(), Delays.DEFAULT, null); }
    public SimulatedGateway(String secret, Clock clock, Duration pendingDelay, Duration lostDelay) {
        this(secret, clock, new Delays(pendingDelay, lostDelay, Delays.DEFAULT.refund(), Delays.DEFAULT.slowLatency()), null);
    }
    /** `resilient` wraps every call to the "bank" (time-out, retries, circuit breaker); null calls it directly (unit tests). */
    public SimulatedGateway(String secret, Clock clock, Delays delays, com.communityos.api.shared.resilience.Resilient resilient) {
        this.secret = secret; this.clock = clock; this.delays = delays; this.resilient = resilient;
    }

    public Mode mode() { return mode; }
    public Mode mode(Mode m) { this.mode = m; return m; }
    public Delays delays() { return delays; }
    /** One call to the payment service, as it answers now. */
    private <T> T bank(java.util.function.Supplier<T> work) {
        java.util.function.Supplier<T> call = () -> {
            Mode m = mode;
            if (m.service() == Service.DOWN) throw new com.communityos.api.shared.resilience.TransientFailure("the simulated payment service is down");
            if (m.service() == Service.SLOW) {
                try { Thread.sleep(delays.slowLatency().toMillis()); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new com.communityos.api.shared.resilience.TransientFailure("interrupted", e); }
            }
            return work.get();
        };
        return resilient == null ? call.get() : resilient.call(call);
    }

    @Override public String name() { return "simulated"; }
    @Override public ProviderOrder createOrder(OrderRequest r) { return bank(() -> newOrder(r)); }
    private ProviderOrder newOrder(OrderRequest r) {
        String ref = "sim_order_" + UUID.randomUUID().toString().replace("-", "").substring(0, 14);
        orders.put(ref, new Sim(ref, r.amount(), r.currency()));
        return new ProviderOrder(ref, Map.of("provider", name(), "providerOrderRef", ref, "amount", r.amount().toString(), "currency", r.currency()));
    }
    /** As before: paid (true) or declined (false), answered at once. */
    public Map<String, String> simulatePay(String orderRef, boolean succeed) { return simulate(orderRef, succeed ? Outcome.SUCCESS : Outcome.FAILURE); }
    /** What the simulated checkout page does when the member presses one of its buttons: returns (paymentRef, signature) for confirm(). */
    public Map<String, String> simulate(String orderRef, Outcome outcome) {
        Sim o = orders.get(orderRef);
        if (o == null) throw new IllegalArgumentException("unknown order");
        Instant now = clock.instant();
        String ref = "sim_pay_" + UUID.randomUUID().toString().replace("-", "").substring(0, 14);
        Instant captured = switch (outcome) { case SUCCESS, LOST -> now; case PENDING -> now.plus(delays.pending()); case FAILURE -> null; };
        payments.put(ref, new Pay(ref, orderRef, o.amount(), o.currency(), captured, outcome == Outcome.FAILURE, outcome == Outcome.FAILURE ? "declined by bank" : null));
        Instant hookAt = switch (outcome) { case SUCCESS, FAILURE -> now; case PENDING -> captured; case LOST -> now.plus(delays.lost()); };
        hooks.add(new Hook(hookAt, "sim_evt_" + UUID.randomUUID().toString().substring(0, 12) + "," + (outcome == Outcome.FAILURE ? "payment.failed" : "payment.captured") + "," + orderRef + "," + ref));
        return Map.of("providerPaymentRef", ref, "signature", Crypto.hmacHex(secret, orderRef + "|" + ref), "outcome", outcome.name().toLowerCase());
    }
    /** The webhooks the provider would have sent by now: (signature header, body), each once. */
    public List<Map.Entry<Map<String, String>, byte[]>> dueWebhooks() {
        Instant now = clock.instant(); List<Map.Entry<Map<String, String>, byte[]>> out = new ArrayList<>();
        for (Hook h : hooks) if (!h.at().isAfter(now) && hooks.remove(h)) {
            byte[] body = h.body().getBytes(StandardCharsets.UTF_8);
            out.add(Map.entry(Map.of("x-simulated-signature", Crypto.hmacHex(secret, body)), body));
        }
        return out;
    }
    @Override public ProviderPayment fetchPayment(String ref) { return bank(() -> payment(ref)); }
    private ProviderPayment payment(String ref) {
        Pay p = payments.get(ref);
        if (p == null) throw new com.communityos.api.shared.domain.DomainException.NotFound("Payment " + ref);
        return asSeenNow(p);
    }
    private ProviderPayment asSeenNow(Pay p) {
        boolean captured = p.capturedAt() != null && !p.capturedAt().isAfter(clock.instant());
        return new ProviderPayment(p.ref(), p.orderRef(), p.amount(), p.currency(), captured, p.failed(), "upi", p.reason());
    }
    @Override public List<ProviderPayment> paymentsOf(String orderRef) { return bank(() -> payments.values().stream().filter((p) -> p.orderRef().equals(orderRef)).map(this::asSeenNow).toList()); }

    // ---- refunds: pending when asked for; processed (or refused, with refunds set to fail) after delays.refund, announced by webhook -----------
    @Override public ProviderRefund refund(RefundRequest r) {
        return bank(() -> {
            Pay p = payments.get(r.providerPaymentRef());
            if (p == null || p.capturedAt() == null || p.capturedAt().isAfter(clock.instant())) throw new IllegalStateException("the simulated bank has no captured payment " + r.providerPaymentRef());
            Rfd same = refunds.values().stream().filter((x) -> x.ref().equals("sim_rfnd_" + r.receipt())).findFirst().orElse(null);
            if (same != null) return asSeenNow(same);                                       // the same request again: the same refund (idempotency key)
            Instant done = clock.instant().plus(delays.refund());
            Rfd f = new Rfd("sim_rfnd_" + r.receipt(), r.providerPaymentRef(), r.amount(), done, mode.refundsFail());
            refunds.put(f.ref(), f);
            hooks.add(new Hook(done, "sim_evt_" + UUID.randomUUID().toString().substring(0, 12) + "," + (f.fails() ? "refund.failed" : "refund.processed") + "," + p.orderRef() + "," + p.ref() + "," + f.ref()));
            return asSeenNow(f);
        });
    }
    @Override public ProviderRefund fetchRefund(String ref) {
        return bank(() -> {
            Rfd f = refunds.get(ref);
            if (f == null) throw new com.communityos.api.shared.domain.DomainException.NotFound("Refund " + ref);
            return asSeenNow(f);
        });
    }
    private ProviderRefund asSeenNow(Rfd f) {
        boolean done = !f.doneAt().isAfter(clock.instant());
        return new ProviderRefund(f.ref(), f.paymentRef(), f.amount(), !done ? "pending" : f.fails() ? "failed" : "processed", done && f.fails() ? "the bank refused the refund (simulated)" : null);
    }
    @Override public boolean verifyCheckout(String orderRef, String paymentRef, String signature) { return Crypto.constantTimeEquals(Crypto.hmacHex(secret, orderRef + "|" + paymentRef), signature); }
    @Override public Optional<WebhookEvent> readWebhook(Map<String, String> headers, byte[] body) {
        String sig = headers.getOrDefault("x-simulated-signature", "");
        if (!Crypto.constantTimeEquals(Crypto.hmacHex(secret, body), sig)) throw new BadSignature();
        String[] parts = new String(body, StandardCharsets.UTF_8).split(",");           // eventId,type,orderRef,paymentRef[,refundRef]
        if (parts.length == 5) return Optional.of(new WebhookEvent(parts[0], parts[1], parts[2], parts[3], parts[4]));
        return parts.length == 4 ? Optional.of(new WebhookEvent(parts[0], parts[1], parts[2], parts[3])) : Optional.empty();
    }
}
