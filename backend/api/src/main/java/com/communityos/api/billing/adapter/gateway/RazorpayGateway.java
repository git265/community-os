package com.communityos.api.billing.adapter.gateway;

import com.communityos.api.billing.application.gateway.PaymentGateway;
import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.http.HttpTransport;
import com.communityos.api.shared.resilience.Resilient;
import com.communityos.api.shared.resilience.TransientFailure;
import com.communityos.api.shared.security.BadSignature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.net.URI;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Adapter for Razorpay (Orders API + Checkout + webhooks). Amounts go to Razorpay in paise. Every call goes through Resilient (timeout,
 * retries with jittered backoff on 5xx / timeouts only, circuit breaker); order creation sends the order id as `receipt` and as the
 * idempotency header, so a retried create cannot make a second order. Secrets come from the secret manager, never from the database.
 *   checkout signature : HMAC_SHA256(order_id + "|" + payment_id, key_secret)
 *   webhook signature  : HMAC_SHA256(raw body, webhook_secret) in X-Razorpay-Signature; event id in X-Razorpay-Event-Id
 */
public final class RazorpayGateway implements PaymentGateway {
    public record Settings(URI baseUrl, String keyId, String keySecret, String webhookSecret) {}
    private static final Set<String> HANDLED = Set.of("payment.captured", "payment.failed", "order.paid");

    private final HttpTransport http; private final Resilient resilient; private final Settings s; private final ObjectMapper json; private final String auth;

    public RazorpayGateway(HttpTransport http, Resilient resilient, Settings settings, ObjectMapper json) {
        this.http = http; this.resilient = resilient; this.s = settings; this.json = json;
        this.auth = "Basic " + Base64.getEncoder().encodeToString((settings.keyId() + ":" + settings.keySecret()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    @Override public String name() { return "razorpay"; }

    @Override public ProviderOrder createOrder(OrderRequest r) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("amount", paise(r.amount())); body.put("currency", r.currency()); body.put("receipt", r.orderId().substring(0, Math.min(40, r.orderId().length())));
        body.put("notes", r.notes());
        JsonNode res = call(HttpTransport.Request.post(s.baseUrl().resolve("/v1/orders"), bytes(body)).header("X-Idempotency-Key", r.orderId()));
        String ref = res.path("id").asText();
        Map<String, Object> checkout = new LinkedHashMap<>();
        checkout.put("provider", name()); checkout.put("key", s.keyId()); checkout.put("providerOrderRef", ref);
        checkout.put("amount", r.amount().toString()); checkout.put("currency", r.currency());
        return new ProviderOrder(ref, checkout);
    }
    @Override public ProviderPayment fetchPayment(String ref) {
        if (!ref.matches("pay_[A-Za-z0-9]{6,40}")) throw new com.communityos.api.shared.domain.DomainException.RuleViolated("bad-payment-ref", "Not a payment reference");
        return toPayment(call(HttpTransport.Request.get(s.baseUrl().resolve("/v1/payments/" + ref))));
    }
    @Override public List<ProviderPayment> paymentsOf(String orderRef) {
        JsonNode res = call(HttpTransport.Request.get(s.baseUrl().resolve("/v1/orders/" + orderRef + "/payments")));
        List<ProviderPayment> out = new ArrayList<>();
        res.path("items").forEach((n) -> out.add(toPayment(n)));
        return out;
    }
    @Override public boolean verifyCheckout(String orderRef, String paymentRef, String signature) {
        return signature != null && Crypto.constantTimeEquals(Crypto.hmacHex(s.keySecret(), orderRef + "|" + paymentRef), signature);
    }
    @Override public Optional<WebhookEvent> readWebhook(Map<String, String> headers, byte[] body) {
        String sig = headers.get("x-razorpay-signature");
        if (sig == null || !Crypto.constantTimeEquals(Crypto.hmacHex(s.webhookSecret(), body), sig)) throw new BadSignature();
        JsonNode n;
        try { n = json.readTree(body); } catch (java.io.IOException e) { return Optional.empty(); }
        String type = n.path("event").asText();
        if (!HANDLED.contains(type)) return Optional.empty();
        JsonNode pay = n.path("payload").path("payment").path("entity");
        String eventId = headers.getOrDefault("x-razorpay-event-id", type + ":" + pay.path("id").asText());
        return Optional.of(new WebhookEvent(eventId, type, pay.path("order_id").asText(null), pay.path("id").asText(null)));
    }

    private ProviderPayment toPayment(JsonNode n) {
        String status = n.path("status").asText();
        return new ProviderPayment(n.path("id").asText(), n.path("order_id").asText(null), new Money(BigDecimal.valueOf(n.path("amount").asLong(), 2)),
            n.path("currency").asText("INR"), "captured".equals(status), "failed".equals(status), n.path("method").asText(null), n.path("error_description").asText(null));
    }
    private JsonNode call(HttpTransport.Request req) {
        return resilient.call(() -> {
            HttpTransport.Response r = http.send(req.header("Authorization", auth));
            if (r.status() >= 500 || r.status() == 429) throw new TransientFailure("razorpay answered " + r.status());
            if (r.status() >= 400) throw new IllegalStateException("razorpay refused the request: " + r.status());
            try { return json.readTree(r.body()); } catch (java.io.IOException e) { throw new TransientFailure("unreadable razorpay answer", e); }
        });
    }
    private byte[] bytes(Object o) { try { return json.writeValueAsBytes(o); } catch (Exception e) { throw new IllegalStateException(e); } }
    static long paise(Money m) { return m.amount().movePointRight(2).longValueExact(); }
}
