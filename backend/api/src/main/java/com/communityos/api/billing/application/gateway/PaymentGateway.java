package com.communityos.api.billing.application.gateway;

import com.communityos.api.shared.domain.Money;
import java.util.Map;
import java.util.Optional;

/**
 * Strategy: one payment provider (Razorpay, a simulator in development; PayU, Cashfree, Stripe later as more implementations). The core never
 * talks HTTP or knows a provider's field names; every provider call is wrapped in Resilient by the implementation.
 */
public interface PaymentGateway {
    record OrderRequest(String orderId, String receipt, Money amount, String currency, Map<String, String> notes) {}
    /** What the app needs to open the provider's checkout. Never contains a secret. */
    record ProviderOrder(String providerOrderRef, Map<String, Object> checkout) {}
    record ProviderPayment(String providerPaymentRef, String providerOrderRef, Money amount, String currency, boolean captured, boolean failed, String method, String failureReason) {}
    record WebhookEvent(String eventId, String type, String providerOrderRef, String providerPaymentRef) {}

    String name();
    ProviderOrder createOrder(OrderRequest request);
    /** The provider's own record of a payment - the amount and status we trust (never the app's). */
    ProviderPayment fetchPayment(String providerPaymentRef);
    /** The payments made against an order (for reconciliation when a webhook never arrived). */
    java.util.List<ProviderPayment> paymentsOf(String providerOrderRef);
    /** Checks the signature the provider's checkout returned to the app. */
    boolean verifyCheckout(String providerOrderRef, String providerPaymentRef, String signature);
    /** Verifies a webhook's signature on the raw body (shared.security.BadSignature if not), then reads it; empty for event types we do not handle. */
    Optional<WebhookEvent> readWebhook(Map<String, String> headers, byte[] rawBody);
}
