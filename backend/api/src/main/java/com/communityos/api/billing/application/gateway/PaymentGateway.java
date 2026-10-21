package com.communityos.api.billing.application.gateway;

import java.util.List;
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
    /** payerRef: who paid as the provider saw it (a UPI payment: the payer's UPI ID); bankRef: the bank's reference (UPI: the 12-digit UTR / RRN). */
    record ProviderPayment(String providerPaymentRef, String providerOrderRef, Money amount, String currency, boolean captured, boolean failed, String method, String failureReason,
                           String payerRef, String bankRef) {
        public ProviderPayment(String providerPaymentRef, String providerOrderRef, Money amount, String currency, boolean captured, boolean failed, String method, String failureReason) {
            this(providerPaymentRef, providerOrderRef, amount, currency, captured, failed, method, failureReason, null, null);
        }
        /** "UPI · asha@okhdfcbank · UTR 612345678901": kept on the payment so the office can match it against the bank statement. */
        public String paidVia() {
            List<String> parts = new java.util.ArrayList<>();
            if (method != null && !method.isBlank()) parts.add("upi".equalsIgnoreCase(method) ? "UPI" : method);
            if (payerRef != null && !payerRef.isBlank()) parts.add(payerRef);
            if (bankRef != null && !bankRef.isBlank()) parts.add(("upi".equalsIgnoreCase(method) ? "UTR " : "Bank ref ") + bankRef);
            return parts.size() > 1 ? String.join(" · ", parts) : null;
        }
    }
    /** A webhook as read: for a refund event (refund.processed, refund.failed) `providerRefundRef` names the refund. */
    record WebhookEvent(String eventId, String type, String providerOrderRef, String providerPaymentRef, String providerRefundRef) {
        public WebhookEvent(String eventId, String type, String providerOrderRef, String providerPaymentRef) { this(eventId, type, providerOrderRef, providerPaymentRef, null); }
        public boolean refund() { return type != null && type.startsWith("refund."); }
    }
    /** Send (part of) a captured payment back to where it came from. `receipt` is our refund's id (the provider's idempotency key). */
    record RefundRequest(String providerPaymentRef, Money amount, String receipt, Map<String, String> notes) {}
    /** The provider's record of a refund: pending, processed (the money went back) or failed. */
    record ProviderRefund(String providerRefundRef, String providerPaymentRef, Money amount, String status, String failureReason) {
        public boolean processed() { return "processed".equals(status); }
        public boolean failed() { return "failed".equals(status); }
    }

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
    /** Ask for a refund of a captured payment; the answer is usually "pending" - the webhook (or fetchRefund) tells when it is done. */
    ProviderRefund refund(RefundRequest request);
    ProviderRefund fetchRefund(String providerRefundRef);
}
