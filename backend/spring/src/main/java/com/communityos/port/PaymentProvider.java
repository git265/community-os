package com.communityos.port;

import com.communityos.payments.PaymentOrder;
import java.math.BigDecimal;
import java.util.Map;
import java.util.Optional;

/** PORT: an online payment provider (Razorpay, Stripe, PayU, Cashfree ...). The browser never sees the provider's secret key. */
public interface PaymentProvider {
    String id();
    /** @param amountMinor paise / cents */
    ProviderOrder createOrder(long amountMinor, String currency, String receipt, Map<String, String> notes);
    /** Check the provider's signature over the RAW body before anything is parsed. */
    boolean verifyWebhook(String rawBody, Map<String, String> headers);
    WebhookEvent parseWebhook(String rawBody);
    /** What the provider says about an order right now (the reconcile job asks when a webhook never came). Empty = no answer yet / not supported. */
    default Optional<ProviderStatus> lookup(PaymentOrder order) throws Exception { return Optional.empty(); }
    ProviderRefund refund(String paymentId, long amountMinor, String reason);

    record ProviderOrder(String providerOrderId, String publicKey) {}
    /**
     * @param type            the provider's event name, kept for the record
     * @param orderId         OUR order id when the provider echoes it (receipt), else blank
     * @param providerOrderId the provider's own order id
     * @param status          Paid | Failed | Pending
     * @param amount          what the provider says it took, in major units (rupees); null when it does not say
     */
    record WebhookEvent(String eventId, String type, String orderId, String providerOrderId, String paymentId, String status, BigDecimal amount, String method) {}
    /** outcome: success | failure | pending */
    record ProviderStatus(String outcome, String method, String paymentId) {}
    record ProviderRefund(String refundId, String status) {}
}
