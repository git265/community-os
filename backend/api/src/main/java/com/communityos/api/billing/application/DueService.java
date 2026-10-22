package com.communityos.api.billing.application;

import com.communityos.api.billing.application.port.ChargeCategories;
import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.application.port.UnitLookup;
import com.communityos.api.billing.domain.ChargeCategory;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.time.Clock;
import java.time.LocalDate;
import java.util.List;

/** Use cases for bills. Every read goes through DuePolicy.readScope, every change through writeScope. */
public final class DueService {
    public record RaiseDue(UnitId unitId, String categoryCode, LocalDate billedMonth, String description, Money amount, LocalDate dueDate) {}

    private final DueRepository dues; private final ChargeCategories categories; private final UnitLookup units; private final DomainEvents events;
    private final AuditWriter audit; private final Tx tx; private final Clock clock;
    private final DuePolicy policy = new DuePolicy();

    public DueService(DueRepository dues, ChargeCategories categories, UnitLookup units, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.dues = dues; this.categories = categories; this.units = units; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    public Page<Due> list(Caller c, DueRepository.Filter f, PageQuery page) { return dues.find(policy.readScope(c), f, page); }
    public Due get(Caller c, DueId id) { return dues.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new); }

    public Due raise(Caller c, RaiseDue cmd) {
        if (cmd.unitId() == null || cmd.categoryCode() == null || cmd.amount() == null || cmd.dueDate() == null)
            throw new DomainException.RuleViolated("required", "Unit, category, amount and due date are required");
        ChargeCategory cat = categories.byCode(cmd.categoryCode()).orElseThrow(() -> new DomainException.RuleViolated("unknown-category", "No charge category " + cmd.categoryCode()));
        UnitLookup.UnitRef unit = units.find(cmd.unitId()).orElseThrow(AccessDenied.NotVisible::new);
        if (!unit.active()) throw new DomainException.RuleViolated("unit-archived", unit.unitNo() + " is archived");
        LocalDate today = LocalDate.now(clock);
        if (cmd.dueDate().isBefore(today.minusYears(1)) || cmd.dueDate().isAfter(today.plusYears(2))) throw new DomainException.RuleViolated("bad-date", "The due date is out of range");
        Due d = Due.raise(c.community(), cmd.unitId(), unit.block(), unit.unitNo(), cat, cmd.billedMonth(), trim(cmd.description()), cmd.amount(), cmd.dueDate(), clock.instant());
        if (!policy.writeScope(c).matches(d)) throw new AccessDenied("You cannot raise " + cat.name() + " bills for " + unit.unitNo());
        return tx.inTx(() -> {
            dues.insert(d);
            events.publish(d.pullEvents());
            audit.write(c, AuditWriter.Action.Create, "billing.due", d.id().value(), d.shortId(), d.unit().value(),
                "Raised " + cat.name() + " " + d.total() + " on " + unit.unitNo(), List.of(new AuditWriter.Change("total", null, d.total().toString())));
            useCredit(c, d);
            return d;
        });
    }

    private BillingDesk desk;
    /** Where a unit's credit is kept (wired after both exist): a new bill is paid from it first. */
    public DueService credits(BillingDesk d) { this.desk = d; return this; }
    /** The unit's credit (an overpayment, a refund kept on account) pays the new bill first, as far as it goes - in the bill's own transaction. */
    private void useCredit(Caller c, Due d) {
        if (desk == null || d.unit() == null) return;
        Money have = desk.credit(d.unit());                                       // locks the unit's credit: two bills at once cannot use it twice
        Money applied = d.applyCredit(have, clock.instant());
        if (!applied.isPositive()) return;
        if (!dues.save(d)) throw new DomainException.Conflict("Bill " + d.shortId());
        desk.useCredit(c, d.unit(), applied, "due", d.id().value(), "Credit used for bill " + d.shortId());
        events.publish(d.pullEvents());
        audit.write(c, AuditWriter.Action.Update, "billing.due", d.id().value(), d.shortId(), d.unit().value(), applied + " of the unit's credit used for bill " + d.shortId(),
            List.of(new AuditWriter.Change("creditApplied", "0", applied.toString())));
    }

    public Due cancel(Caller c, DueId id, String reason, long expectedVersion) { return close(c, id, reason, expectedVersion, true); }
    public Due waive(Caller c, DueId id, String reason, long expectedVersion) { return close(c, id, reason, expectedVersion, false); }

    private Due close(Caller c, DueId id, String reason, long expectedVersion, boolean cancel) {
        return tx.inTx(() -> {
            Due d = dues.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
            if (!policy.writeScope(c).matches(d)) throw new AccessDenied("You cannot change this bill");
            if (d.version() != expectedVersion) throw new DomainException.Conflict("Bill " + d.shortId());
            String before = d.status().label();
            if (cancel) d.cancel(reason, clock.instant()); else d.waive(reason, clock.instant());
            if (!dues.save(d)) throw new DomainException.Conflict("Bill " + d.shortId());
            events.publish(d.pullEvents());
            audit.write(c, AuditWriter.Action.Update, "billing.due", d.id().value(), d.shortId(), d.unit() == null ? null : d.unit().value(),
                (cancel ? "Cancelled " : "Waived ") + d.shortId() + ": " + d.cancelReason(), List.of(new AuditWriter.Change("status", before, d.status().label())));
            return d;
        });
    }

    private static String trim(String s) {
        if (s == null || s.isBlank()) return null;
        if (s.length() > 500) throw new DomainException.RuleViolated("too-long", "The description is too long");
        return s.strip();
    }
}
