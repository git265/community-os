package com.communityos.api.billing.application.port;

import com.communityos.api.billing.domain.BillingEvents.Allocation;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.domain.Ids.PaymentId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface PaymentRepository {
    record NewPayment(PaymentId id, OrderId order, UnitId unit, Money amount, String method, String provider, String providerRef, Instant receivedAt, String note) {}
    record Receipt(PaymentId id, String receiptNo, UnitId unit, OrderId order, Money amount, String method, String provider, Instant receivedAt, List<Allocation> allocations, Money toCredit) {
        public Receipt { allocations = List.copyOf(allocations); }
    }
    Optional<Receipt> findByProviderRef(String provider, String providerRef);
    /** This provider payment is already recorded (the unique key said so). */
    final class AlreadyRecorded extends RuntimeException { public AlreadyRecorded() { super("payment already recorded"); } }
    /** Inserts the payment and returns its receipt number; AlreadyRecorded for a second insert of the same provider payment. */
    String insert(NewPayment p);
    void allocate(PaymentId payment, List<Allocation> allocations);
    void creditUnit(UnitId unit, Money amount, PaymentId source, String reason);
    /** A signed credit row of any kind (prepayment, applied-to-booking, booking-refund ...). */
    void creditRow(UnitId unit, Money signedAmount, String sourceType, java.util.UUID sourceId, String reason);
    /** The unit's credit now (sum of its rows), read with a row lock on the unit so two uses cannot both spend it. */
    Money lockCreditBalance(UnitId unit);
    /** Claim a prepayment for one record: its amount, or empty when it is not this unit's, not a prepayment of this purpose, or already claimed. */
    Optional<Money> claim(PaymentId payment, UnitId unit, String purpose, String targetType, java.util.UUID targetId);
    Optional<Receipt> findById(PaymentId id);
    /** The payment that settled an order, once there is one. */
    Optional<PaymentId> ofOrder(OrderId order);
}
