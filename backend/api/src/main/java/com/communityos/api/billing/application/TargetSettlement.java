package com.communityos.api.billing.application;

import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.domain.BillingEvents.Allocation;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Money received at the office for a booking or a donation. Not exposed by a controller: the module that owns the record (amenities, cultural)
 * has already checked who may record it and what is owed; this records the payment and applies it, through the same Settlement skeleton.
 */
public final class TargetSettlement extends Settlement<TargetSettlement.Request> {
    public record Request(UnitId unitId, Money amount, String method, String reference, String targetType, UUID targetId, Money owed) {}
    static final Set<String> METHODS = Set.of("Cash", "Cheque", "Bank transfer", "UPI", "Card", "Net banking");
    private final Clock clock;
    public TargetSettlement(DueRepository dues, PaymentRepository payments, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) { super(dues, payments, events, audit, tx); this.clock = clock; }

    @Override protected Verified verify(Caller c, Request r) {
        if (r.unitId() == null) throw new DomainException.RuleViolated("unit-required", "A payment is received from a unit");
        if (!METHODS.contains(r.method())) throw new DomainException.RuleViolated("bad-method", "Method must be one of " + METHODS);
        if (!Set.of("booking", "donation").contains(r.targetType())) throw new DomainException.RuleViolated("bad-target", "A booking or a donation");
        String ref = r.reference() == null || r.reference().isBlank() ? null : r.reference().strip();
        // a payment made online but recorded by the office (UPI to the community's account ...) has no provider: it is "received", like a transfer
        String method = Set.of("UPI", "Card", "Net banking").contains(r.method()) ? "Bank transfer" : r.method();
        return new Verified(r.unitId(), null, r.amount(), method, null, null, clock.instant(), List.of(), ref == null ? r.method() : r.method() + " " + ref, r.targetType(),
            new Allocation(r.targetType(), r.targetId(), r.owed()));
    }
}
