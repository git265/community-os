package com.communityos.payments;

import com.communityos.service.Tx;
import java.math.BigDecimal;

/**
 * A booking paid online must point at a real, unused, big-enough payment of the same unit. Kept apart from PaymentService (which needs the record
 * service) so the record service can use it without the two depending on each other.
 */
public class BookingPaymentClaims implements BookingClaims {
    private final PaymentStore store;
    private final Tx tx;

    public BookingPaymentClaims(PaymentStore store, Tx tx) { this.store = store; this.tx = tx; }

    @Override
    public String claimForBooking(String tenant, String ref, String unit, BigDecimal amount, String bookingId) {
        PaymentOrder o = store.paidBookingByPaymentId(tenant, ref).orElse(null);
        if (o == null) return "That payment was not found. Pay online first, then book.";
        if (!o.unit().equals(unit)) return "That payment was made for another unit.";
        if (o.amount().add(new BigDecimal("0.009")).compareTo(amount) < 0) return "The payment is less than the booking total.";
        if (o.consumedBy() != null && !o.consumedBy().equals(bookingId)) return "That payment has already been used for another booking.";
        return tx.run(() -> store.claim(o.orderId(), bookingId)) ? "" : "That payment has already been used for another booking.";   // one atomic statement
    }
}
