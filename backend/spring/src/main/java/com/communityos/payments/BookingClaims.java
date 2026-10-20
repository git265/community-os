package com.communityos.payments;

import java.math.BigDecimal;

/** Lets an amenity booking take hold of the online payment it was paid with (one payment pays one booking). */
public interface BookingClaims {
    /** @return "" when the payment is now this booking's, else the reason it cannot be used */
    String claimForBooking(String tenant, String ref, String unit, BigDecimal amount, String bookingId);
}
