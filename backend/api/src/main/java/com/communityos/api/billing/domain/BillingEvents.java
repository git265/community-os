package com.communityos.api.billing.domain;

import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.domain.Ids.PaymentId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** Facts the billing module publishes (in-process to the ledger, and through the outbox to integrations). Payloads carry no personal data. */
public final class BillingEvents {
    private BillingEvents() {}

    public record DueRaised(DueId dueId, CommunityId communityId, UnitId unitId, UUID categoryId, UUID incomeAccountId, Money amount, Money tax,
                            LocalDate billedMonth, LocalDate dueDate, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "billing.due.raised"; }
        @Override public UUID aggregateId() { return dueId.value(); }
    }
    public record DuePaid(DueId dueId, CommunityId communityId, UnitId unitId, Money total, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "billing.due.paid"; }
        @Override public UUID aggregateId() { return dueId.value(); }
    }
    public record DueCancelled(DueId dueId, CommunityId communityId, UnitId unitId, UUID incomeAccountId, Money amount, Money tax, String reason, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "billing.due.cancelled"; }
        @Override public UUID aggregateId() { return dueId.value(); }
    }
    public record DueWaived(DueId dueId, CommunityId communityId, UnitId unitId, Money waived, String reason, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "billing.due.waived"; }
        @Override public UUID aggregateId() { return dueId.value(); }
    }
    public record Allocation(DueId dueId, Money amount) {}
    public record PaymentRecorded(PaymentId paymentId, String receiptNo, CommunityId communityId, UnitId unitId, OrderId orderId, Money amount, List<Allocation> allocations,
                                  Money toCredit, String method, String provider, Instant occurredAt) implements DomainEvent {
        public PaymentRecorded { allocations = List.copyOf(allocations); }
        @Override public String topic() { return "billing.payment.recorded"; }
        @Override public UUID aggregateId() { return paymentId.value(); }
        public boolean viaGateway() { return provider != null; }
    }
    public record PaymentOrderFailed(OrderId orderId, CommunityId communityId, UnitId unitId, String reason, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "billing.payment-order.failed"; }
        @Override public UUID aggregateId() { return orderId.value(); }
    }
}
