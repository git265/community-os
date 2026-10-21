package com.communityos.api.billing.domain;

import com.communityos.api.billing.domain.BillingEvents.DueCancelled;
import com.communityos.api.billing.domain.BillingEvents.DuePaid;
import com.communityos.api.billing.domain.BillingEvents.DueRaised;
import com.communityos.api.billing.domain.BillingEvents.DueWaived;
import com.communityos.api.shared.domain.AggregateRoot;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/**
 * A bill on a unit (aggregate root). The amounts are the server's: tax is computed from the category, the total is amount + tax, and only
 * settle() moves money onto it - nobody can type a paid amount or a status. The database repeats the same rules as CHECK constraints.
 */
public final class Due extends AggregateRoot {
    private final DueId id; private final CommunityId community; private String shortId; private final UnitId unit; private final BlockId block; private final String unitNo;
    private final ChargeCategory category; private final LocalDate billedMonth; private final String description; private final Money amount; private final Money tax;
    private Money paid; private final Money credit; private final LocalDate dueDate; private DueStatus status; private Instant paidAt; private String cancelReason;
    private final Instant createdAt;

    public Due(DueId id, CommunityId community, String shortId, UnitId unit, BlockId block, String unitNo, ChargeCategory category, LocalDate billedMonth, String description, Money amount,
               Money tax, Money paid, Money credit, LocalDate dueDate, DueStatus status, Instant paidAt, String cancelReason, Instant createdAt, long version) {
        this.id = id; this.community = community; this.shortId = shortId; this.unit = unit; this.block = block; this.unitNo = unitNo; this.category = category; this.billedMonth = billedMonth;
        this.description = description; this.amount = amount; this.tax = tax; this.paid = paid; this.credit = credit; this.dueDate = dueDate; this.status = status;
        this.paidAt = paidAt; this.cancelReason = cancelReason; this.createdAt = createdAt; this.version = version;
    }

    /** Factory: a new bill. */
    public static Due raise(CommunityId community, UnitId unit, BlockId block, String unitNo, ChargeCategory category, LocalDate billedMonth, String description, Money amount,
                            LocalDate dueDate, Instant now) {
        if (!category.active()) throw new DomainException.RuleViolated("category-inactive", category.name() + " is no longer billed");
        if (amount.isNegative() || amount.isZero()) throw new DomainException.RuleViolated("bad-amount", "The amount must be more than zero");
        if (amount.compareTo(Money.of(10_000_000)) > 0) throw new DomainException.RuleViolated("bad-amount", "The amount is too large");
        if (billedMonth != null && billedMonth.getDayOfMonth() != 1) billedMonth = billedMonth.withDayOfMonth(1);
        Money tax = amount.percent(category.taxRate());
        Due d = new Due(new DueId(UUID.randomUUID()), community, null, unit, block, unitNo, category, billedMonth, description, amount, tax, Money.ZERO, Money.ZERO,
            dueDate, DueStatus.UNPAID, null, null, now, 0);
        d.raise(new DueRaised(d.id, community, unit, category.id(), category.incomeAccountId(), amount, tax, billedMonth, dueDate, now));
        return d;
    }

    public Money total() { return amount.plus(tax); }
    public Money outstanding() { return status.isOpen() ? total().minus(paid).minus(credit) : Money.ZERO; }

    /** Puts up to `offered` on this bill; returns what was actually applied (zero for a closed bill, so the rest becomes the unit's credit). */
    public Money settle(Money offered, Instant at) {
        if (!status.isOpen() || !offered.isPositive()) return Money.ZERO;
        Money applied = offered.min(outstanding());
        paid = paid.plus(applied);
        DueStatus to = outstanding().isZero() ? DueStatus.PAID : DueStatus.PARTLY_PAID;
        move(to);
        paidAt = at;
        if (to == DueStatus.PAID) raise(new DuePaid(id, community, unit, total(), at));
        return applied;
    }

    public void cancel(String reason, Instant at) {
        requireReason(reason);
        if (paid.isPositive() || credit.isPositive()) throw new DomainException.RuleViolated("due-has-payments", "A bill with payments cannot be cancelled - waive the rest instead");
        move(DueStatus.CANCELLED);
        cancelReason = reason.strip();
        raise(new DueCancelled(id, community, unit, category.incomeAccountId(), amount, tax, cancelReason, at));
    }

    public void waive(String reason, Instant at) {
        requireReason(reason);
        Money rest = outstanding();
        move(DueStatus.WAIVED);
        cancelReason = reason.strip();
        raise(new DueWaived(id, community, unit, rest, cancelReason, at));
    }

    private void move(DueStatus to) {
        if (!status.canMoveTo(to)) throw new DomainException.RuleViolated("due-closed", "This bill is " + status.label() + " and cannot be changed");
        status = to;
    }
    private static void requireReason(String reason) {
        if (reason == null || reason.strip().length() < 3 || reason.length() > 500) throw new DomainException.RuleViolated("reason-required", "Give a reason (3-500 characters)");
    }
    /** Set by the repository after insert (the database gives the number). */
    public void numbered(String shortId) { this.shortId = shortId; }

    public DueId id() { return id; } public CommunityId community() { return community; } public String shortId() { return shortId; } public UnitId unit() { return unit; }
    public BlockId block() { return block; } public String unitNo() { return unitNo; } public ChargeCategory category() { return category; } public LocalDate billedMonth() { return billedMonth; }
    public String description() { return description; } public Money amount() { return amount; } public Money tax() { return tax; } public Money paid() { return paid; }
    public Money credit() { return credit; } public LocalDate dueDate() { return dueDate; } public DueStatus status() { return status; } public Instant paidAt() { return paidAt; }
    public String cancelReason() { return cancelReason; } public Instant createdAt() { return createdAt; }
    public boolean overdue(LocalDate today) { return status.isOpen() && dueDate.isBefore(today); }
}
