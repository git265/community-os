package com.communityos.api.finance.application;

import com.communityos.api.approval.application.ApprovalSettings;
import com.communityos.api.approval.domain.Plan;
import com.communityos.api.approval.domain.Policy;
import com.communityos.api.finance.application.port.FinanceStore;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.maintenance.application.port.TaskMoney;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;

/**
 * Releases: money released on an approved task (within what is still open on its approved quotation / invoice) or on an approved event expense
 * (within its amount). A release has its own approval plan (the community's rules for "Maintenance release" / "Cultural release"); approved,
 * it is paid by the accounts - which writes the cash book entry and posts it; an event expense whose releases cover it becomes Paid. An unpaid
 * release is cancelled with a reason; a rejected one can be changed and sent again.
 */
public final class ReleaseService {
    public record ReleaseEvent(String topic, UUID aggregateId, CommunityId communityId, UUID ticketId, UUID expenseId, UUID raisedBy, BigDecimal amount, String status, Instant occurredAt) implements DomainEvent {}
    public record NewRelease(UUID ticketId, UUID expenseId, String kind, BigDecimal amount, String vendor, String note) {}
    static final BigDecimal TOLERANCE = new BigDecimal("0.50");

    private final FinanceStore store; private final TaskMoney money; private final ApprovalSettings approvals; private final CashBookService cash; private final DomainEvents events;
    private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public ReleaseService(FinanceStore store, TaskMoney money, ApprovalSettings approvals, CashBookService cash, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.money = money; this.approvals = approvals; this.cash = cash; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    public List<Books.Release> list(Caller c, UUID ticketId, UUID expenseId) { requireSeer(c); return store.releases(ticketId, expenseId); }
    public Books.Release get(Caller c, UUID id) { requireSeer(c); return store.release(id).orElseThrow(AccessDenied.NotVisible::new); }
    public String whyNot(Caller c, Books.Release r) {
        if (!"Waiting approval".equals(r.status) || r.plan == null) return "Nothing to decide";
        return approvals.settings().approvers().whyNot(r.plan, c, r.raisedById == null ? null : r.raisedById.toString());
    }

    public Books.Release raise(Caller c, NewRelease n) {
        boolean cultural = n.expenseId() != null;
        if (!FinancePolicy.raisesRelease(c, cultural)) throw new AccessDenied("Only the EC, the coordinators, the cultural committee or the accounts raise releases");
        if ((n.ticketId() == null) == (n.expenseId() == null)) throw new DomainException.RuleViolated("release-for", "A release is on a task or on an event expense");
        if (n.amount() == null || n.amount().signum() <= 0) throw new DomainException.RuleViolated("amount-required", "Enter the amount to release");
        return tx.inTx(() -> {
            Books.Release r = new Books.Release();
            r.ticketId = n.ticketId(); r.expenseId = n.expenseId(); r.kind = n.kind() == null ? "Release" : n.kind(); r.amount = Books.r2(n.amount()); r.vendor = blank(n.vendor()); r.note = blank(n.note());
            r.raisedById = c.membership() == null ? null : c.membership().value(); r.raisedBy = c.displayName();
            if (!List.of("Release", "Against quotation", "Against invoice", "Advance", "Stage", "Final").contains(r.kind)) throw new DomainException.RuleViolated("bad-kind", "Release, Against quotation, Against invoice, Advance, Stage or Final");
            within(r, null);
            r.plan = Policy.build(approvals.policies(), new Policy.Context(cultural ? "Cultural release" : "Maintenance release", r.amount, null, null, List.of()), clock.instant());
            r.mirror();
            store.insert(r);
            done(c, r, "finance.release.raised", AuditWriter.Action.Create, "Release of " + r.amount.toPlainString() + " raised");
            return store.release(r.id).orElseThrow();
        });
    }
    public Books.Release decide(Caller c, UUID id, long version, String value, String comment, boolean finish) {
        if (c.membership() == null) throw new AccessDenied("Sign in to decide");
        return tx.inTx(() -> {
            Books.Release r = current(id, version);
            if (!"Waiting approval".equals(r.status)) throw new DomainException.RuleViolated("decided", "This release is " + r.status.toLowerCase());
            Plan next;
            try {
                if ("Pending".equals(value)) next = r.plan.undo(c.membership().toString());
                else if ("Approved".equals(value) || "Rejected".equals(value)) {
                    String why = whyNot(c, r);
                    if (why != null) throw new AccessDenied(why);
                    if ("Rejected".equals(value) && (comment == null || comment.isBlank())) throw new DomainException.RuleViolated("reason-required", "Say why it is rejected");
                    next = r.plan.decide(c.membership().toString(), c.displayName(), clock.instant(), value, comment, finish);
                } else throw new DomainException.RuleViolated("bad-decision", "Approved, Rejected or Pending (undo)");
            } catch (IllegalStateException e) { throw new DomainException.RuleViolated("not-waiting", e.getMessage()); }
            r.plan = next; r.mirror();
            if (!store.update(r)) throw new DomainException.Conflict("Release " + r.shortId);
            done(c, r, "finance.release.decided", AuditWriter.Action.Update, value + " release " + r.shortId);
            return store.release(id).orElseThrow();
        });
    }
    /** Change a rejected release (or one nobody has decided on yet) - it is sent for approval again. */
    public Books.Release change(Caller c, UUID id, long version, String kind, BigDecimal amount, String vendor, String note) {
        return tx.inTx(() -> {
            Books.Release r = current(id, version);
            if (!FinancePolicy.raisesRelease(c, r.expenseId != null)) throw new AccessDenied("You cannot change releases");
            boolean rejected = "Rejected".equals(r.status);
            if (!rejected && (!"Waiting approval".equals(r.status) || r.plan.anyDecision())) throw new DomainException.RuleViolated("decided", "A release being approved or decided is not changed");
            if (kind != null) r.kind = kind;
            if (amount != null) r.amount = Books.r2(amount);
            r.vendor = blank(vendor); r.note = blank(note);
            within(r, r.id);
            r.status = "Waiting approval";
            r.plan = Policy.build(approvals.policies(), new Policy.Context(r.expenseId != null ? "Cultural release" : "Maintenance release", r.amount, null, null, List.of()), clock.instant());
            if (!store.update(r)) throw new DomainException.Conflict("Release " + r.shortId);
            done(c, r, rejected ? "finance.release.resubmitted" : "finance.release.changed", AuditWriter.Action.Update, "Release " + r.shortId + " changed");
            return store.release(id).orElseThrow();
        });
    }
    /** Pay an approved release: the cash book entry is written and posted. */
    public Books.Release pay(Caller c, UUID id, long version, String mode, String ref, LocalDate date) {
        if (!FinancePolicy.paysRelease(c)) throw new AccessDenied("Only the accounts or the EC pay releases");
        return tx.inTx(() -> {
            Books.Release r = current(id, version);
            if (!"Approved".equals(r.status)) throw new DomainException.RuleViolated("not-approved", "Only an approved release is paid");
            Books.Entry e = new Books.Entry();
            e.date = date == null ? LocalDate.now(clock) : date; e.type = "Debit"; e.amount = r.amount; e.vendor = r.vendor; e.mode = mode == null ? "Bank transfer" : mode; e.ref = blank(ref);
            e.description = "Release " + r.shortId + (r.ticketShortId != null ? " on " + r.ticketShortId : "") + (r.vendor == null ? "" : " to " + r.vendor);
            e.sourceType = "release"; e.sourceId = r.id; e.sourceLabel = r.kind; e.taskRef = r.ticketShortId; e.module = r.expenseId != null ? "Cultural" : "Maintenance";
            Books.Entry paid = cash.recordApproved(c, e);
            r.status = "Paid"; r.paidAt = clock.instant(); r.paidEntryId = paid.id;
            if (!store.update(r)) throw new DomainException.Conflict("Release " + r.shortId);
            if (r.expenseId != null) store.expenseMoney(r.expenseId).ifPresent((x) -> {
                if (x.paid().add(TOLERANCE).compareTo(x.amount()) >= 0) store.markExpensePaid(x.id(), "Paid in releases");
            });
            done(c, r, "finance.release.paid", AuditWriter.Action.Update, "Paid release " + r.shortId + " (" + paid.shortId + ")");
            return store.release(id).orElseThrow();
        });
    }
    public Books.Release cancel(Caller c, UUID id, long version, String reason) {
        if (!FinancePolicy.paysRelease(c) && !c.isSuperAdmin()) throw new AccessDenied("Only the EC or the accounts cancel releases");
        if (reason == null || reason.isBlank()) throw new DomainException.RuleViolated("reason-required", "Say why the release is cancelled");
        return tx.inTx(() -> {
            Books.Release r = current(id, version);
            if (!List.of("Waiting approval", "Approved").contains(r.status)) throw new DomainException.RuleViolated("cannot-cancel", "A " + r.status.toLowerCase() + " release is not cancelled");
            r.status = "Cancelled"; r.cancelReason = reason.strip(); r.cancelledAt = clock.instant(); r.cancelledById = c.membership() == null ? null : c.membership().value();
            if (!store.update(r)) throw new DomainException.Conflict("Release " + r.shortId);
            done(c, r, "finance.release.cancelled", AuditWriter.Action.Update, "Cancelled release " + r.shortId + ": " + r.cancelReason);
            return store.release(id).orElseThrow();
        });
    }

    /** What may still be released: on a task, what is open on its approved quotation / invoice; on an event expense, its amount less live releases. */
    private void within(Books.Release r, UUID self) {
        BigDecimal mine = self == null ? BigDecimal.ZERO : store.release(self).filter((x) -> !List.of("Rejected", "Cancelled").contains(x.status)).map((x) -> x.amount).orElse(BigDecimal.ZERO);
        if (r.ticketId != null) {
            TaskMoney.Position p = money.position(r.ticketId);
            if (p.cap().amount().signum() <= 0) throw new DomainException.RuleViolated("not-approved", "Nothing is approved on this task yet - its quotation or invoice needs approval first");
            BigDecimal open = p.remaining() == null ? BigDecimal.ZERO : p.remaining().amount().add(mine);
            if (r.amount.compareTo(open.add(TOLERANCE)) > 0) throw new DomainException.RuleViolated("over-approved", "Only " + open.toPlainString() + " is still open on the approved amount");
        } else {
            FinanceStore.ExpenseMoney x = store.expenseMoney(r.expenseId).orElseThrow(() -> new DomainException.RuleViolated("no-expense", "That event expense does not exist"));
            if (!"Approved".equals(x.status())) throw new DomainException.RuleViolated("not-approved", "The event expense needs approval first");
            BigDecimal open = x.amount().subtract(x.released()).add(mine);
            if (r.amount.compareTo(open.add(TOLERANCE)) > 0) throw new DomainException.RuleViolated("over-approved", "Only " + open.toPlainString() + " is still open on this expense");
        }
    }
    private Books.Release current(UUID id, long version) {
        Books.Release r = store.release(id).orElseThrow(AccessDenied.NotVisible::new);
        if (r.version != version) throw new DomainException.Conflict("Release " + r.shortId);
        return r;
    }
    private void done(Caller c, Books.Release r, String topic, AuditWriter.Action a, String summary) {
        events.publish(List.of(new ReleaseEvent(topic, r.id, c.community(), r.ticketId, r.expenseId, r.raisedById, r.amount, r.status, clock.instant())));
        audit.write(c, a, "finance.release", r.id, r.shortId, null, summary, List.of());
    }
    static String blank(String s) { return s == null || s.isBlank() ? null : s.strip(); }
    static void requireSeer(Caller c) { if (!FinancePolicy.reader(c) && !FinancePolicy.raisesRelease(c, true)) throw new AccessDenied("Releases are for the committee, the coordinators and the accounts"); }
}
