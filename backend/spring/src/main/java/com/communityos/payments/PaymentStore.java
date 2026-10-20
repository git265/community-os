package com.communityos.payments;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;

/**
 * PORT: where payment orders and the provider events already seen are kept (tables payment_orders / payment_events).
 * Methods marked LOCK must be called inside a transaction: the row stays locked until it ends, so two settlements of one order queue up.
 */
public interface PaymentStore {
    void insert(PaymentOrder o);
    Optional<PaymentOrder> get(String tenant, String orderId);
    /** The webhook knows only the order id: the order says which community it belongs to. */
    Optional<PaymentOrder> find(String orderId);
    Optional<PaymentOrder> findByProviderRef(String providerRef);
    /** LOCK */
    Optional<PaymentOrder> lock(String tenant, String orderId);
    /** LOCK: a Created / Pending order with this key (a repeated click comes back to it). */
    Optional<PaymentOrder> lockOpenByKey(String tenant, String key);
    boolean paidWithKey(String tenant, String key);
    /** Money taken for a booking and never used, for this payer and amount. */
    Optional<PaymentOrder> unusedPaidBooking(String tenant, String unit, BigDecimal amount, String payerId);
    /** @return true the first time this provider event id is seen */
    boolean recordEvent(String eventId, String orderId, String type);
    void markPaid(String orderId, String paymentId, String method);
    /** Unconditional (the amount did not match: a person must look). */
    void markFailed(String orderId, String note);
    /** Created/Pending -> status (Failed | Pending | Expired); a Paid order is never moved. @return rows changed */
    int moveOpen(String orderId, String status, String method, String note);
    void touch(String orderId);
    void recordBank(String orderId, JsonNode bank);
    /** Created/Pending orders nobody has looked at for `seconds`, oldest first. */
    List<PaymentOrder> openNotTouchedFor(long seconds, int limit);
    Optional<PaymentOrder> paidBookingByPaymentId(String tenant, String paymentId);
    /** One atomic step: of two bookings racing for one payment, exactly one gets it. */
    boolean claim(String orderId, String bookingId);
}
