package com.communityos.api.maintenance.application;

import com.communityos.api.approval.application.ApprovalSettings;
import com.communityos.api.approval.domain.Plan;
import com.communityos.api.approval.domain.Policy;
import com.communityos.api.maintenance.application.port.QuotationRepository;
import com.communityos.api.maintenance.application.port.TaskMoney;
import com.communityos.api.maintenance.application.port.TicketRepository;
import com.communityos.api.maintenance.domain.Quotation;
import com.communityos.api.maintenance.domain.Ticket;
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
import java.util.List;
import java.util.UUID;

/**
 * Quotations and invoices on a task, and their approvals (the legacy ticketEngine / MoneyGuard rules, on the server):
 *   - only the people who run the queue add documents, and only on a task marked as involving money
 *   - a quotation is decided once it is selected; selecting another one is refused once money is released or paid on the approved one
 *   - an invoice within its approved quotation can skip approval (community setting); above it (beyond the tolerance) it is "over budget"
 *   - each decision is checked against the document's plan: the waiting step, an eligible approver, once per person, never one's own request
 *     when the community keeps approvals separate
 *   - an approved invoice is sent back for correction (with a note) only while nothing is paid on it; it is never deleted
 */
public final class QuotationService {
    public record AddDocument(String kind, String vendor, BigDecimal amount, String gstMode, BigDecimal gstRate, LocalDate quoteDate, String note) {}
    public record Changed(String topic, UUID aggregateId, CommunityId communityId, UUID ticketId, String kind, String status, Instant occurredAt) implements DomainEvent {}
    static final Money TOLERANCE = Money.of("0.50");

    private final TicketRepository tickets; private final QuotationRepository docs; private final TaskMoney money; private final ApprovalSettings approvals;
    private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    private final TicketPolicy policy = new TicketPolicy();

    public QuotationService(TicketRepository tickets, QuotationRepository docs, TaskMoney money, ApprovalSettings approvals, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.tickets = tickets; this.docs = docs; this.money = money; this.approvals = approvals; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    /** Who sees the money side of tasks: the queue runners, the committee, the final approvers and the accounts. */
    public boolean seesMoney(Caller c) {
        return TicketRules.coordinator(c) || c.has(Permission.MANAGE_LEDGER) || approvals.settings().approvers().isFinal(c);
    }
    static boolean mayAdd(Caller c) { return TicketRules.coordinator(c); }

    public List<Quotation> ofTicket(Caller c, UUID ticketId) { ticket(c, ticketId); requireMoney(c); return docs.ofTicket(ticketId); }
    public List<Quotation> all(Caller c) { requireMoney(c); return docs.all(policy.readScope(c)); }
    public TaskMoney.Position position(Caller c, UUID ticketId) { ticket(c, ticketId); requireMoney(c); return money.position(ticketId); }
    public Quotation get(Caller c, UUID id) { requireMoney(c); Quotation q = docs.get(id).orElseThrow(AccessDenied.NotVisible::new); ticket(c, q.ticketId()); return q; }

    /** Why this caller cannot decide the document now (null = they can). */
    public String whyNot(Caller c, Quotation q) {
        if (!q.selected()) return "Not selected";
        if (q.state().approvalWaived || q.plan() == null) return "No approval needed";
        return approvals.settings().approvers().whyNot(q.plan(), c, q.state().createdBy == null ? null : q.state().createdBy.toString());
    }

    // ---- add ----------------------------------------------------------------------------------------------------------------------------------
    public Quotation add(Caller c, UUID ticketId, AddDocument cmd) {
        if (!mayAdd(c)) throw new AccessDenied("Only the Facility Manager, the MEP or the EC add quotations and invoices");
        if (cmd.kind() == null || !Quotation.KINDS.contains(cmd.kind())) throw new DomainException.RuleViolated("bad-kind", "Quotation or Invoice");
        if (cmd.note() != null && cmd.note().length() > 4000) throw new DomainException.RuleViolated("bad-note", "The note is too long");
        Quotation.Amounts a = Quotation.Amounts.of(cmd.amount(), cmd.gstMode(), cmd.gstRate());
        if (a.total().amount().signum() == 0) throw new DomainException.RuleViolated("bad-amount", "Enter the amount on the document");
        if (blank(cmd.vendor()) == null) throw new DomainException.RuleViolated("vendor-required", "Who is the quotation or invoice from?");
        if (cmd.vendor().strip().length() > 200) throw new DomainException.RuleViolated("too-long", "The vendor name is too long");
        return tx.inTx(() -> {
            Ticket t = ticket(c, ticketId);
            if (t.status().finished()) throw new DomainException.RuleViolated("ticket-finished", "This task is " + t.status().label().toLowerCase() + " - reopen it first");
            if (!t.financial()) throw new DomainException.RuleViolated("not-financial", "Mark the task as involving money first");
            ApprovalSettings.Settings st = approvals.settings();
            Instant now = clock.instant();
            Quotation.State s = new Quotation.State();
            s.id = UUID.randomUUID(); s.ticketId = ticketId; s.kind = cmd.kind(); s.vendor = blank(cmd.vendor()); s.baseAmount = a.base(); s.gstMode = cmd.gstMode() == null ? "None" : cmd.gstMode();
            s.gstRate = cmd.gstRate(); s.gstAmount = a.gst(); s.amount = a.total(); s.quoteDate = cmd.quoteDate(); s.note = blank(cmd.note());
            s.createdBy = c.membership() == null ? null : c.membership().value(); s.createdByName = c.displayName();
            Quotation q = new Quotation(s);
            String tt = t.taskType() == null ? null : t.taskType().name();
            if (q.invoice()) {
                Money approved = t.approval().approvedAmount();
                boolean quoteOk = t.approval().quotationApproved() && approved != null && approved.amount().signum() > 0;
                BigDecimal limit = quoteOk ? approved.amount().multiply(BigDecimal.ONE.add(st.invoiceTolerancePct().movePointLeft(2))).add(TOLERANCE.amount()) : null;
                s.overBudget = quoteOk && a.total().amount().compareTo(limit) > 0;
                s.selected = true;
                if (st.invoiceSkipWithinQuote() && quoteOk && !s.overBudget) q.plan(Plan.waived(now, a.total().amount(), "Within the approved quotation"), true);
                else q.plan(Policy.build(approvals.policies(), new Policy.Context("Maintenance invoice", a.total().amount(), t.category(), tt, s.overBudget ? List.of("overBudget") : List.of()), now), false);
            } else {
                s.selected = false;
                q.plan(Policy.build(approvals.policies(), new Policy.Context("Maintenance quotation", a.total().amount(), t.category(), tt, List.of()), now), false);
            }
            docs.insert(q);
            mirror(t, q);
            done(c, t, q, AuditWriter.Action.Create, "added", "Added " + q.state().kind.toLowerCase() + " " + q.shortId() + " (" + q.amount().amount().toPlainString() + ") on " + t.shortId());
            return q;
        });
    }

    // ---- select ---------------------------------------------------------------------------------------------------------------------------------
    public Quotation select(Caller c, UUID id, long version) {
        if (!mayAdd(c)) throw new AccessDenied("Only the Facility Manager, the MEP or the EC choose the quotation");
        return tx.inTx(() -> {
            Quotation q = current(c, id, version);
            if (q.invoice()) throw new DomainException.RuleViolated("not-a-quotation", "Only a quotation is selected - an invoice counts once it is approved");
            Ticket t = ticket(c, q.ticketId());
            if (t.status().finished()) throw new DomainException.RuleViolated("ticket-finished", "This task is finished");
            if (q.selected()) return q;
            UUID was = t.approval().selectedQuotationId();
            if (was != null && t.approval().quotationApproved()) {
                TaskMoney.Position m = money.position(t.id());
                if (m.committed().amount().compareTo(TOLERANCE.amount()) > 0)
                    throw new DomainException.RuleViolated("money-committed", m.committed().amount().toPlainString() + " is already released or paid on the approved quotation - cancel the releases and reverse the payments first");
            }
            for (Quotation other : docs.ofTicket(t.id())) if (!other.invoice() && other.selected() && !other.id().equals(q.id())) { other.select(false); if (!docs.save(other)) throw new DomainException.Conflict("Quotation " + other.shortId()); }
            q.select(true);
            if (!docs.save(q)) throw new DomainException.Conflict("Quotation " + q.shortId());
            mirror(t, q);
            done(c, t, q, AuditWriter.Action.Update, "selected", "Selected quotation " + q.shortId() + " for " + t.shortId());
            return q;
        });
    }

    // ---- decide ---------------------------------------------------------------------------------------------------------------------------------
    /** value: Approved | Rejected | Pending (= undo my latest decision). finish: approve and skip the later steps, where the step allows it. */
    public Quotation decide(Caller c, UUID id, long version, String value, String comment, boolean finish) {
        if (c.membership() == null) throw new AccessDenied("Sign in to decide");
        return tx.inTx(() -> {
            Quotation q = current(c, id, version);
            Ticket t = ticket(c, q.ticketId());
            if (!q.selected()) throw new DomainException.RuleViolated("not-selected", "Select this quotation first");
            if (q.state().approvalWaived) throw new DomainException.RuleViolated("waived", "This invoice is within its approved quotation - it needs no approval");
            ApprovalSettings.Settings st = approvals.settings();
            Plan plan = q.plan() == null ? Policy.build(approvals.policies(), new Policy.Context(q.invoice() ? "Maintenance invoice" : "Maintenance quotation", q.amount().amount(), t.category(),
                t.taskType() == null ? null : t.taskType().name(), q.state().overBudget ? List.of("overBudget") : List.of()), clock.instant()) : q.plan();
            boolean wasApproved = q.approved();
            Plan next;
            try {
                if ("Pending".equals(value)) next = plan.undo(c.membership().toString());
                else if ("Approved".equals(value) || "Rejected".equals(value)) {
                    String why = st.approvers().whyNot(plan, c, q.state().createdBy == null ? null : q.state().createdBy.toString());
                    if (why != null) throw new AccessDenied(why);
                    if ("Rejected".equals(value) && (comment == null || comment.isBlank())) throw new DomainException.RuleViolated("reason-required", "Say why it is rejected");
                    // money is approved against the document itself: an invoice with no PDF or photo of it attached is not approved
                    if ("Approved".equals(value) && q.invoice() && docs.files(q.id()) == 0) throw new DomainException.RuleViolated("document-required", "Attach the invoice (PDF or photo) before it is approved");
                    next = plan.decide(c.membership().toString(), c.displayName(), clock.instant(), value, comment, finish);
                } else throw new DomainException.RuleViolated("bad-decision", "Approved, Rejected or Pending (undo)");
            } catch (IllegalStateException e) { throw new DomainException.RuleViolated("not-waiting", e.getMessage()); }
            q.plan(next, false);
            if (wasApproved && !q.approved()) guardUndo(t, q);
            if (!docs.save(q)) throw new DomainException.Conflict((q.invoice() ? "Invoice " : "Quotation ") + q.shortId());
            mirror(t, q);
            done(c, t, q, AuditWriter.Action.Update, "decided", ("Pending".equals(value) ? "Undid a decision on " : value + " ") + q.state().kind.toLowerCase() + " " + q.shortId() + " of " + t.shortId());
            return q;
        });
    }

    /** Send an approved invoice back for correction: only while nothing is paid on it, with a note; its approval starts again. */
    public Quotation sendBack(Caller c, UUID id, long version, String note) {
        if (!(mayAdd(c) || approvals.settings().approvers().isFinal(c))) throw new AccessDenied("You cannot send invoices back");
        return tx.inTx(() -> {
            Quotation q = current(c, id, version);
            if (!q.invoice() || !q.approved()) throw new DomainException.RuleViolated("not-approved-invoice", "Only an approved invoice is sent back for correction");
            if (money.paidOn(q.id()).amount().signum() > 0) throw new DomainException.RuleViolated("paid", "Payments are recorded against this invoice - reverse them before sending it back for correction");
            Ticket t = ticket(c, q.ticketId());
            q.sendBack(note, Policy.build(approvals.policies(), new Policy.Context("Maintenance invoice", q.amount().amount(), t.category(), t.taskType() == null ? null : t.taskType().name(),
                q.state().overBudget ? List.of("overBudget") : List.of()), clock.instant()));
            if (!docs.save(q)) throw new DomainException.Conflict("Invoice " + q.shortId());
            mirror(t, q);
            done(c, t, q, AuditWriter.Action.Update, "sent-back", "Sent invoice " + q.shortId() + " back for correction: " + q.state().correctionNote);
            return q;
        });
    }

    public void remove(Caller c, UUID id, long version) {
        if (!mayAdd(c)) throw new AccessDenied("You cannot remove quotations or invoices");
        tx.run(() -> {
            Quotation q = current(c, id, version);
            Ticket t = ticket(c, q.ticketId());
            if (money.paidOn(q.id()).amount().signum() > 0) throw new DomainException.RuleViolated("paid", "Payments are recorded against this document - reverse them first");
            if (q.invoice() && q.approved()) throw new DomainException.RuleViolated("approved-invoice", "An approved invoice cannot be deleted. Send it back for correction first.");
            if (!q.invoice() && q.selected() && money.position(t.id()).committed().amount().compareTo(TOLERANCE.amount()) > 0)
                throw new DomainException.RuleViolated("money-committed", "Money has been released or paid against this quotation - cancel the releases / reverse the payments first");
            if (!docs.delete(q.id(), q.version())) throw new DomainException.Conflict("Document " + q.shortId());
            q.select(false);
            mirror(t, q);
            done(c, t, q, AuditWriter.Action.Delete, "removed", "Removed " + q.state().kind.toLowerCase() + " " + q.shortId() + " from " + t.shortId());
        });
    }

    // ---- the task's money summary ----------------------------------------------------------------------------------------------------------
    /** Recompute what the task shows from its selected quotation and its invoices. */
    private void mirror(Ticket t, Quotation changed) {
        List<Quotation> all = docs.ofTicket(t.id());
        Quotation quote = all.stream().filter((x) -> !x.invoice() && x.selected()).findFirst().orElse(null);
        List<Quotation> invoices = all.stream().filter(Quotation::invoice).filter(Quotation::selected).toList();
        Quotation lastInvoice = invoices.isEmpty() ? null : invoices.get(invoices.size() - 1);
        String qs = quote != null ? quote.status() : all.stream().anyMatch((x) -> !x.invoice()) ? "Received" : "None";
        String is = lastInvoice == null ? "None" : lastInvoice.state().correctionNote != null && !lastInvoice.approved() ? "Sent back" : lastInvoice.status();
        Quotation.State qst = quote == null ? null : quote.state();
        Money approvedAmount = quote != null && quote.approved() ? quote.amount() : null;
        docs.saveTicketApproval(t.id(), new Ticket.Approval(qs, is, approvedAmount, quote == null ? null : quote.id(), lastInvoice == null ? null : lastInvoice.id(),
            qst == null ? null : qst.ecApproval, qst == null ? null : qst.finalApproval, qst != null && qst.finalRequired));
    }

    /** Undoing an approval that money already rests on is refused. */
    private void guardUndo(Ticket t, Quotation q) {
        if (q.invoice()) {
            if (money.paidOn(q.id()).amount().signum() > 0) throw new DomainException.RuleViolated("paid", "Payments are recorded against this invoice - reverse them before undoing its approval");
            return;
        }
        TaskMoney.Position m = money.position(t.id());
        if (m.committed().amount().compareTo(TOLERANCE.amount()) > 0)
            throw new DomainException.RuleViolated("money-committed", m.committed().amount().toPlainString() + " is already released or paid on this approval - cancel the releases and reverse the payments before undoing it");
    }

    private Quotation current(Caller c, UUID id, long version) {
        Quotation q = get(c, id);
        if (q.version() != version) throw new DomainException.Conflict((q.invoice() ? "Invoice " : "Quotation ") + q.shortId());
        return q;
    }
    private Ticket ticket(Caller c, UUID id) { return tickets.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new); }
    private void requireMoney(Caller c) { if (!seesMoney(c)) throw new AccessDenied("You cannot see the quotations and invoices of tasks"); }
    private void done(Caller c, Ticket t, Quotation q, AuditWriter.Action a, String verb, String summary) {
        events.publish(List.of(new Changed("maintenance.quotation." + verb, q.id(), c.community(), t.id(), q.state().kind, q.status(), clock.instant())));
        audit.write(c, a, "maintenance.quotation", q.id(), q.shortId(), t.unit() == null ? null : t.unit().value(), summary, List.of());
    }
    private static String blank(String s) { return s == null || s.isBlank() ? null : s.strip(); }
}
