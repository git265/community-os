package com.communityos.api.cultural.application;

import com.communityos.api.approval.application.ApprovalSettings;
import com.communityos.api.approval.domain.Plan;
import com.communityos.api.approval.domain.Policy;
import com.communityos.api.billing.application.BillingDesk;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.cultural.application.port.CulturalStore;
import com.communityos.api.cultural.domain.Cultural;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;

/**
 * Event expenses and the event's budget. The committee raises an expense; it goes through the community's approval rules like a task's
 * quotation (EC first; a final approver too when it is over the event's limit - the plan's "eventFinal" flag); each decision is checked against
 * the plan (the waiting step, an eligible approver, never one's own request when approvals are kept separate). A rejected expense can be
 * changed and sent again. An approved one is paid by a final approver (Dr 5100 Event expenses / Cr bank). Once the event is completed, a final
 * approver may credit its unused budget back to the fund.
 */
public final class ExpenseService {
    public record ExpenseEvent(String topic, UUID aggregateId, CommunityId communityId, UUID eventId, UUID raisedBy, String item, BigDecimal amount, String status, String waitingFor,
                               Instant occurredAt) implements DomainEvent {}
    public record Fields(String item, String category, String vendor, BigDecimal amount, BigDecimal estimate, LocalDate date, String fund, String note) {}

    private final CulturalStore store; private final ApprovalSettings approvals; private final BillingDesk desk; private final DomainEvents events; private final AuditWriter audit;
    private final Tx tx; private final Clock clock;
    public ExpenseService(CulturalStore store, ApprovalSettings approvals, BillingDesk desk, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.approvals = approvals; this.desk = desk; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    public List<Cultural.Expense> list(Caller c, UUID eventId) { requireFinance(c); return store.expenses(eventId); }
    public Cultural.Expense get(Caller c, UUID id) { requireFinance(c); return store.expense(id).orElseThrow(AccessDenied.NotVisible::new); }
    /** Why this caller cannot decide the expense now (null = they can). */
    public String whyNot(Caller c, Cultural.Expense x) {
        if (!"Pending approval".equals(x.status) || x.plan == null) return "Nothing to decide";
        return approvals.settings().approvers().whyNot(x.plan, c, x.raisedById == null ? null : x.raisedById.toString());
    }

    public Cultural.Expense raise(Caller c, UUID eventId, Fields f) {
        requireRaiser(c);
        return tx.inTx(() -> {
            Cultural.Event ev = store.event(eventId, false).orElseThrow(AccessDenied.NotVisible::new);
            if ("Cancelled".equals(ev.status())) throw new DomainException.RuleViolated("event-cancelled", ev.name() + " is cancelled");
            Cultural.Expense x = apply(new Cultural.Expense(), f);
            x.eventId = eventId; x.raisedById = c.membership() == null ? null : c.membership().value(); x.raisedBy = c.displayName();
            x.check();
            x.plan = plan(ev, x); x.mirror();
            store.insert(x);
            done(c, x, "cultural.expense.raised", AuditWriter.Action.Create, "Raised " + x.value().toPlainString() + " for " + x.item);
            return store.expense(x.id).orElseThrow();
        });
    }
    /** Change an expense while nobody has decided on it yet, or after it was rejected (it then starts again). */
    public Cultural.Expense change(Caller c, UUID id, long version, Fields f) {
        requireRaiser(c);
        return tx.inTx(() -> {
            Cultural.Expense x = current(id, version);
            boolean rejected = "Rejected".equals(x.status);
            if (!rejected && (!"Pending approval".equals(x.status) || x.plan.anyDecision()))
                throw new DomainException.RuleViolated("under-approval", "This expense is already being approved or is decided - ask the approver to reject it for changes");
            apply(x, f); x.check();
            Cultural.Event ev = store.event(x.eventId, false).orElseThrow();
            x.status = "Pending approval"; x.plan = plan(ev, x); x.mirror();
            if (!store.update(x)) throw new DomainException.Conflict("Expense " + x.shortId);
            done(c, x, rejected ? "cultural.expense.resubmitted" : "cultural.expense.changed", AuditWriter.Action.Update, (rejected ? "Sent again: " : "Changed: ") + x.item);
            return store.expense(id).orElseThrow();
        });
    }
    /** value: Approved | Rejected | Pending (undo my latest decision); finish: approve and skip later steps where the step allows it. */
    public Cultural.Expense decide(Caller c, UUID id, long version, String value, String comment, boolean finish) {
        if (c.membership() == null) throw new AccessDenied("Sign in to decide");
        return tx.inTx(() -> {
            Cultural.Expense x = current(id, version);
            if (!"Pending approval".equals(x.status) && !"Pending".equals(value)) throw new DomainException.RuleViolated("decided", "This expense is already " + x.status.toLowerCase());
            if ("Paid".equals(x.status)) throw new DomainException.RuleViolated("paid", "This expense is paid");
            Plan next;
            try {
                if ("Pending".equals(value)) next = x.plan.undo(c.membership().toString());
                else if ("Approved".equals(value) || "Rejected".equals(value)) {
                    if (x.amount == null || x.amount.signum() <= 0) throw new DomainException.RuleViolated("amount-required", "Enter the actual amount before it is approved");
                    String why = whyNot(c, x);
                    if (why != null) throw new AccessDenied(why);
                    if ("Rejected".equals(value) && (comment == null || comment.isBlank())) throw new DomainException.RuleViolated("reason-required", "Say why it is rejected");
                    next = x.plan.decide(c.membership().toString(), c.displayName(), clock.instant(), value, comment, finish);
                } else throw new DomainException.RuleViolated("bad-decision", "Approved, Rejected or Pending (undo)");
            } catch (IllegalStateException e) { throw new DomainException.RuleViolated("not-waiting", e.getMessage()); }
            x.plan = next; x.mirror();
            if (!store.update(x)) throw new DomainException.Conflict("Expense " + x.shortId);
            done(c, x, "cultural.expense.decided", AuditWriter.Action.Update, value + " " + x.item);
            return store.expense(id).orElseThrow();
        });
    }
    /** An approved expense paid out - by a final approver (or the accounts). */
    public Cultural.Expense pay(Caller c, UUID id, long version, String mode) {
        if (!(approvals.settings().approvers().isFinal(c) || c.has(Permission.MANAGE_LEDGER) || c.isSuperAdmin())) throw new AccessDenied("Only a final approver or the accounts mark an expense paid");
        return tx.inTx(() -> {
            Cultural.Expense x = current(id, version);
            if (!"Approved".equals(x.status)) throw new DomainException.RuleViolated("not-approved", "Only an approved expense is paid");
            if (x.amount == null || x.amount.signum() <= 0) throw new DomainException.RuleViolated("amount-required", "Enter the actual amount spent before marking it paid");
            // paid once: an expense with money in releases is paid through those releases, never directly as well
            if (store.released(x.id).signum() > 0) throw new DomainException.RuleViolated("paid-by-releases", "This expense is being paid through releases - pay the release instead");
            Instant now = clock.instant();
            x.status = "Paid"; x.paidAt = now; x.paidById = c.membership() == null ? null : c.membership().value(); x.paidMode = mode == null || mode.isBlank() ? "Bank transfer" : mode;
            if (!store.update(x)) throw new DomainException.Conflict("Expense " + x.shortId);
            Money amt = new Money(x.amount);
            desk.post(new Journal.Entry(now.atZone(clock.getZone()).toLocalDate(), "Event expense " + x.shortId + " · " + x.item, "expense", x.id,
                List.of(Journal.Line.debit("5100", null, amt, x.item), Journal.Line.credit("1000", null, amt, "Paid (" + x.paidMode + ")"))));
            done(c, x, "cultural.expense.paid", AuditWriter.Action.Update, "Paid " + x.amount.toPlainString() + " for " + x.item);
            return store.expense(id).orElseThrow();
        });
    }
    public void remove(Caller c, UUID id, long version) {
        requireRaiser(c);
        tx.run(() -> {
            Cultural.Expense x = current(id, version);
            if (List.of("Approved", "Paid").contains(x.status)) throw new DomainException.RuleViolated("decided", "An approved or paid expense is not deleted");
            if (!store.deleteExpense(id, version)) throw new DomainException.Conflict("Expense " + x.shortId);
            audit.write(c, AuditWriter.Action.Delete, "cultural.expense", x.id, x.shortId, null, x.item, List.of());
        });
    }

    /** A completed event's unused budget credited back to its fund (a record of the decision; no bank movement). */
    public Cultural.Event credit(Caller c, UUID eventId, long version, BigDecimal amount, String note) {
        if (!(approvals.settings().approvers().isFinal(c) || c.isSuperAdmin())) throw new AccessDenied("Only the Treasurer or the final approvers credit unused budget back to the fund");
        return tx.inTx(() -> {
            Cultural.Event ev = store.event(eventId, true).orElseThrow(AccessDenied.NotVisible::new);
            if (ev.version() != version) throw new DomainException.Conflict("Event " + ev.name());
            if (!"Completed".equals(ev.status())) throw new DomainException.RuleViolated("not-completed", "Credit the unused budget once the event is completed");
            if (amount == null || amount.signum() <= 0) throw new DomainException.RuleViolated("amount-required", "Enter the amount to credit");
            if (amount.compareTo(ev.unused().add(new BigDecimal("0.50"))) > 0) throw new DomainException.RuleViolated("too-much", "At most the unused budget (" + ev.unused().toPlainString() + ")");
            if (!store.credit(eventId, version, amount, note)) throw new DomainException.Conflict("Event " + ev.name());
            audit.write(c, AuditWriter.Action.Update, "cultural.event", ev.id(), null, null, "Credited " + amount.toPlainString() + " of unused budget to " + (ev.fund() == null ? "the fund" : ev.fund()), List.of());
            return store.event(eventId, false).orElseThrow();
        });
    }

    private Plan plan(Cultural.Event ev, Cultural.Expense x) {
        boolean fin = ev.needsFinal(x.value());
        Plan p = Policy.build(approvals.policies(), new Policy.Context("Cultural expense", x.value(), x.category, null, fin ? List.of("eventFinal") : List.of()), clock.instant());
        // no rule of the community's own and under the event's limit: the EC's approval is the last step
        if (!fin && p.rules().isEmpty() && p.steps().size() > 1) p = new Plan(p.version(), p.built(), List.of("Under the event's final-approval limit"), p.amount(), p.steps().subList(0, 1), p.overrides());
        return p;
    }
    private Cultural.Expense current(UUID id, long version) {
        Cultural.Expense x = store.expense(id).orElseThrow(AccessDenied.NotVisible::new);
        if (x.version != version) throw new DomainException.Conflict("Expense " + x.shortId);
        return x;
    }
    static Cultural.Expense apply(Cultural.Expense x, Fields f) {
        x.item = f.item(); x.category = blank(f.category()); x.vendor = blank(f.vendor()); x.amount = f.amount(); x.estimate = f.estimate(); x.date = f.date(); x.fund = blank(f.fund()); x.note = blank(f.note());
        return x;
    }
    private void done(Caller c, Cultural.Expense x, String topic, AuditWriter.Action a, String summary) {
        String waiting = !"Pending approval".equals(x.status) ? null : "Pending".equals(x.ecApproval) ? "ec" : "final";
        events.publish(List.of(new ExpenseEvent(topic, x.id, c.community(), x.eventId, x.raisedById, x.item, x.value(), x.status, waiting, clock.instant())));
        audit.write(c, a, "cultural.expense", x.id, x.shortId, null, summary, List.of());
    }
    static String blank(String s) { return s == null || s.isBlank() ? null : s.strip(); }
    static void requireFinance(Caller c) { if (!CulturalPolicy.finance(c) && !c.has(Permission.MANAGE_CULTURAL)) throw new AccessDenied("Event expenses are for the committee and the accounts"); }
    static void requireRaiser(Caller c) { if (!CulturalPolicy.manager(c) && !c.isCommittee()) throw new AccessDenied("The cultural committee raises event expenses"); }
}
