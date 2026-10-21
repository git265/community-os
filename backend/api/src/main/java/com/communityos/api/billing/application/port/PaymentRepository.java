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
    Optional<Receipt> findById(PaymentId id);
}
