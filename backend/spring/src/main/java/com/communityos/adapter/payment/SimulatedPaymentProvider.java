package com.communityos.adapter.payment;

import com.communityos.port.PaymentProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.communityos.payments.PaymentOrder;
import java.math.BigDecimal;
import java.util.Optional;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Demo provider: no money moves. It still signs and verifies webhooks with HMAC-SHA256 exactly like Razorpay/Stripe do,
 * so the order -> webhook -> settle flow is the real one. To add Razorpay or Stripe, implement PaymentProvider with their
 * SDK (createOrder, verify header X-Razorpay-Signature / Stripe-Signature, parse event) and register it in ProvidersConfig.
 */
public class SimulatedPaymentProvider implements PaymentProvider {
    private final String secret;
    private final ObjectMapper json = new ObjectMapper();

    public SimulatedPaymentProvider(String secret) { this.secret = secret; }

    @Override public String id() { return "simulated"; }

    @Override public ProviderOrder createOrder(long amountMinor, String currency, String receipt, Map<String, String> notes) {
        return new ProviderOrder("sim_order_" + UUID.randomUUID().toString().replace("-", "").substring(0, 14), "sim_public_key");
    }

    static String hmac(String secret, String body) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        StringBuilder sb = new StringBuilder();
        for (byte b : mac.doFinal(body.getBytes(StandardCharsets.UTF_8))) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    @Override public boolean verifyWebhook(String rawBody, Map<String, String> headers) {
        try {
            String given = headers.getOrDefault("x-signature", headers.getOrDefault("x-webhook-signature", ""));
            return MessageDigest.isEqual(hmac(secret, rawBody).getBytes(StandardCharsets.UTF_8), given.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) { return false; }
    }

    @Override public WebhookEvent parseWebhook(String rawBody) {
        try {
            JsonNode n = json.readTree(rawBody);
            String type = n.path("type").asText();
            String status = type.endsWith("captured") ? "Paid" : type.endsWith("failed") ? "Failed" : "Pending";
            BigDecimal amount = n.hasNonNull("amount") ? new BigDecimal(n.path("amount").asText()) : null;
            return new WebhookEvent(n.path("id").asText(), type, n.path("orderId").asText(""), n.path("providerOrderId").asText(""), n.path("paymentId").asText(), status, amount,
                    n.path("method").asText(""));
        } catch (Exception e) { throw new IllegalArgumentException("Unreadable webhook body"); }
    }

    /** The signature a test (or the dev-only simulate endpoint) puts on an event it plays as "the bank". */
    public String sign(String rawBody) {
        try { return hmac(secret, rawBody); } catch (Exception e) { throw new IllegalStateException(e); }
    }

    /** The pretend bank's decision is stored on the order (what simulate recorded), the way a real provider's status call would answer. */
    @Override public Optional<ProviderStatus> lookup(PaymentOrder o) {
        JsonNode b = o.bank();
        if (b == null || b.isNull() || !b.hasNonNull("outcome")) return Optional.empty();
        return Optional.of(new ProviderStatus(b.path("outcome").asText(), b.path("method").asText(""), b.path("paymentId").asText("")));
    }

    @Override public ProviderRefund refund(String paymentId, long amountMinor, String reason) {
        return new ProviderRefund("sim_refund_" + UUID.randomUUID().toString().substring(0, 8), "Processed");
    }
}
