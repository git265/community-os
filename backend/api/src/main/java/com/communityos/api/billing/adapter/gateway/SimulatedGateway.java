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
 */
public final class SimulatedGateway implements PaymentGateway {
    public enum Outcome { SUCCESS, FAILURE, PENDING, LOST }
    private record Sim(String orderRef, Money amount, String currency) {}
    /** A payment as the bank sees it: charged from `capturedAt` (null: never), or declined. */
    private record Pay(String ref, String orderRef, Money amount, String currency, Instant capturedAt, boolean failed, String reason) {}
    private record Hook(Instant at, String body) {}
    private final Map<String, Sim> orders = new ConcurrentHashMap<>();
    private final Map<String, Pay> payments = new ConcurrentHashMap<>();
    private final ConcurrentLinkedQueue<Hook> hooks = new ConcurrentLinkedQueue<>();
    private final String secret; private final Clock clock; private final Duration pendingDelay, lostDelay;

    public SimulatedGateway(String secret) { this(secret, Clock.systemUTC(), Duration.ofSeconds(30), Duration.ofSeconds(20)); }
    public SimulatedGateway(String secret, Clock clock, Duration pendingDelay, Duration lostDelay) {
        this.secret = secret; this.clock = clock; this.pendingDelay = pendingDelay; this.lostDelay = lostDelay;
    }

    @Override public String name() { return "simulated"; }
    @Override public ProviderOrder createOrder(OrderRequest r) {
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
        Instant captured = switch (outcome) { case SUCCESS, LOST -> now; case PENDING -> now.plus(pendingDelay); case FAILURE -> null; };
        payments.put(ref, new Pay(ref, orderRef, o.amount(), o.currency(), captured, outcome == Outcome.FAILURE, outcome == Outcome.FAILURE ? "declined by bank" : null));
        Instant hookAt = switch (outcome) { case SUCCESS, FAILURE -> now; case PENDING -> captured; case LOST -> now.plus(lostDelay); };
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
    @Override public ProviderPayment fetchPayment(String ref) {
        Pay p = payments.get(ref);
        if (p == null) throw new com.communityos.api.shared.domain.DomainException.NotFound("Payment " + ref);
        return asSeenNow(p);
    }
    private ProviderPayment asSeenNow(Pay p) {
        boolean captured = p.capturedAt() != null && !p.capturedAt().isAfter(clock.instant());
        return new ProviderPayment(p.ref(), p.orderRef(), p.amount(), p.currency(), captured, p.failed(), "upi", p.reason());
    }
    @Override public List<ProviderPayment> paymentsOf(String orderRef) { return payments.values().stream().filter((p) -> p.orderRef().equals(orderRef)).map(this::asSeenNow).toList(); }
    @Override public boolean verifyCheckout(String orderRef, String paymentRef, String signature) { return Crypto.constantTimeEquals(Crypto.hmacHex(secret, orderRef + "|" + paymentRef), signature); }
    @Override public Optional<WebhookEvent> readWebhook(Map<String, String> headers, byte[] body) {
        String sig = headers.getOrDefault("x-simulated-signature", "");
        if (!Crypto.constantTimeEquals(Crypto.hmacHex(secret, body), sig)) throw new BadSignature();
        String[] parts = new String(body, StandardCharsets.UTF_8).split(",");           // eventId,type,orderRef,paymentRef
        return parts.length == 4 ? Optional.of(new WebhookEvent(parts[0], parts[1], parts[2], parts[3])) : Optional.empty();
    }
}
