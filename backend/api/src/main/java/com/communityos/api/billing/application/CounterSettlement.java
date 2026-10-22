package com.communityos.api.billing.application;

import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.application.port.UnitLookup;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;

/** Money received at the office (cash, cheque, bank transfer), entered by someone with MANAGE_DUES. */
public final class CounterSettlement extends Settlement<CounterSettlement.Request> {
    public record Request(UnitId unitId, Money amount, String method, LocalDate receivedOn, List<DueId> dueIds, String reference) {}
    private static final Set<String> METHODS = Set.of("Cash", "Cheque", "Bank transfer");

    private final UnitLookup units; private final Clock clock;
    public CounterSettlement(DueRepository dues, PaymentRepository payments, DomainEvents events, AuditWriter audit, Tx tx, UnitLookup units, Clock clock) {
        super(dues, payments, events, audit, tx); this.units = units; this.clock = clock;
    }

    @Override protected Verified verify(Caller c, Request r) {
        if (!c.isSuperAdmin() && !c.has(Permission.MANAGE_DUES)) throw new AccessDenied("You cannot record payments");
        if (r.unitId() == null || r.amount() == null || r.method() == null) throw new DomainException.RuleViolated("required", "Unit, amount and method are required");
        if (!METHODS.contains(r.method())) throw new DomainException.RuleViolated("bad-method", "Method must be one of " + METHODS);
        if (r.amount().compareTo(Money.of(10_000_000)) > 0) throw new DomainException.RuleViolated("bad-amount", "The amount is too large");
        UnitLookup.UnitRef unit = units.find(r.unitId()).orElseThrow(AccessDenied.NotVisible::new);
        if (c.isBlockLimited() && (unit.block() == null || !c.blocks().contains(unit.block()))) throw new AccessDenied.NotVisible();
        LocalDate today = LocalDate.now(clock);
        LocalDate on = r.receivedOn() == null ? today : r.receivedOn();
        if (on.isAfter(today) || on.isBefore(today.minusDays(90))) throw new DomainException.RuleViolated("bad-date", "The date must be within the last 90 days");
        Instant at = on.equals(today) ? clock.instant() : on.atStartOfDay(clock.getZone()).toInstant();
        String ref = r.reference() == null || r.reference().isBlank() ? null : r.reference().strip();
        if (ref != null && ref.length() > 100) throw new DomainException.RuleViolated("too-long", "The reference is too long");
        // money that is not cash is matched to the bank statement by its reference
        if (ref == null && !List.of("Cash", "Unit credit").contains(r.method()))
            throw new DomainException.RuleViolated("reference-required", "Enter the " + ("Cheque".equals(r.method()) ? "cheque number" : "transaction reference (UTR)"));
        List<DueId> ids = r.dueIds() == null ? List.of() : List.copyOf(r.dueIds());
        if (ids.size() > 50) throw new DomainException.RuleViolated("too-many", "At most 50 bills per receipt");
        return new Verified(r.unitId(), null, r.amount(), r.method(), null, null, at, ids, ref);
    }
}
