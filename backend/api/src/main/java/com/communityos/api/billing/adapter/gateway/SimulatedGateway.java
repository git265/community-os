package com.communityos.api.billing.adapter.gateway;

import com.communityos.api.billing.application.gateway.PaymentGateway;
import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.BadSignature;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A provider for development and tests (payments.providers.simulated.enabled=true; refused in prod): orders live in memory, the "checkout"
 * signature is HMAC(secret, order|payment) exactly like Razorpay's, so the same app code path is exercised. `simulatePay` plays the customer.
 */
public final class SimulatedGateway implements PaymentGateway {
    private record Sim(String orderRef, Money amount, String currency) {}
    private final Map<String, Sim> orders = new ConcurrentHashMap<>();
    private final Map<String, ProviderPayment> payments = new ConcurrentHashMap<>();
    private final String secret;

    public SimulatedGateway(String secret) { this.secret = secret; }

    @Override public String name() { return "simulated"; }
    @Override public ProviderOrder createOrder(OrderRequest r) {
        String ref = "sim_order_" + UUID.randomUUID().toString().replace("-", "").substring(0, 14);
        orders.put(ref, new Sim(ref, r.amount(), r.currency()));
        return new ProviderOrder(ref, Map.of("provider", name(), "providerOrderRef", ref, "amount", r.amount().toString(), "currency", r.currency()));
    }
    /** What the simulated checkout page does when the member presses Pay: returns (paymentRef, signature) for confirm(). */
    public Map<String, String> simulatePay(String orderRef, boolean succeed) {
        Sim o = orders.get(orderRef);
        if (o == null) throw new IllegalArgumentException("unknown order");
        String pay = "sim_pay_" + UUID.randomUUID().toString().replace("-", "").substring(0, 14);
        payments.put(pay, new ProviderPayment(pay, orderRef, o.amount(), o.currency(), succeed, !succeed, "upi", succeed ? null : "declined by bank"));
        return Map.of("providerPaymentRef", pay, "signature", Crypto.hmacHex(secret, orderRef + "|" + pay));
    }
    @Override public ProviderPayment fetchPayment(String ref) {
        ProviderPayment p = payments.get(ref);
        if (p == null) throw new com.communityos.api.shared.domain.DomainException.NotFound("Payment " + ref);
        return p;
    }
    @Override public List<ProviderPayment> paymentsOf(String orderRef) { return payments.values().stream().filter((p) -> p.providerOrderRef().equals(orderRef)).toList(); }
    @Override public boolean verifyCheckout(String orderRef, String paymentRef, String signature) { return Crypto.constantTimeEquals(Crypto.hmacHex(secret, orderRef + "|" + paymentRef), signature); }
    @Override public Optional<WebhookEvent> readWebhook(Map<String, String> headers, byte[] body) {
        String sig = headers.getOrDefault("x-simulated-signature", "");
        if (!Crypto.constantTimeEquals(Crypto.hmacHex(secret, body), sig)) throw new BadSignature();
        String[] parts = new String(body, java.nio.charset.StandardCharsets.UTF_8).split(",");           // eventId,type,orderRef,paymentRef
        return parts.length == 4 ? Optional.of(new WebhookEvent(parts[0], parts[1], parts[2], parts[3])) : Optional.empty();
    }
}
