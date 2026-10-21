package com.communityos.api.maintenance.domain;

import com.communityos.api.maintenance.domain.TicketEvents.TicketAssigned;
import com.communityos.api.maintenance.domain.TicketEvents.TicketRaised;
import com.communityos.api.maintenance.domain.TicketEvents.TicketStatusChanged;
import com.communityos.api.shared.domain.AggregateRoot;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Names;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * A maintenance ticket (aggregate root). Its status only moves through TicketStatus; who may move it is checked by TicketRules before a
 * method here is called. Times (assigned / started / completed / closed / cancelled) are set by the moves, never typed in.
 */
public final class Ticket extends AggregateRoot {
    public static final List<String> PRIORITIES = List.of("Low", "Medium", "High", "Critical");
    public static final List<String> CATEGORIES = List.of("Plumbing", "Electrical", "MEP", "Carpentry", "Civil & Painting", "Water & Sewage", "Housekeeping", "Gardening",
        "Landscape", "Security", "Fire safety", "Amenities", "Cultural", "Helpdesk", "General", "Other");

    /** Everything a ticket holds; the aggregate is built from it and keeps it consistent. */
    public static final class State {
        public UUID id; public CommunityId community; public String shortId; public TaskType taskType; public String title; public String description;
        public UnitId unit; public String unitNo; public BlockId block; public String scope = "Unit"; public String location; public String category; public String subCategory;
        public String priority = "Medium"; public TicketStatus status = TicketStatus.OPEN; public MembershipId assignee; public String assigneeName;
        public LocalDate slaDueAt; public String preferredTime; public Set<UnitId> affectedUnits = new LinkedHashSet<>(); public Integer residentRating;
        public MembershipId raisedBy; public String raisedByName; public String raisedByRole; public boolean awaitingParts; public Money materialsCost;
        public boolean financial; public LocalDate workDone; public Instant assignedAt, startedAt, completedAt, closedAt, cancelledAt; public String cancelReason;
        public int reopenCount; public Map<String, Object> custom = Map.of(); public Instant createdAt, updatedAt; public long version;
        /** Where the money side stands (written by the quotation workflow, read-only here). */
        public Approval approval = Approval.NONE;
    }

    /** The money side of a task: the selected quotation / invoice and their approvals (two-slot summary), and the approved amount. */
    public record Approval(String quotationStatus, String invoiceStatus, Money approvedAmount, UUID selectedQuotationId, UUID selectedInvoiceId,
                           String ecApproval, String treasurerApproval, Boolean finalRequired) {
        public static final Approval NONE = new Approval(null, null, null, null, null, null, null, null);
        public boolean quotationApproved() { return "Approved".equals(quotationStatus); }
    }

    private final State s;
    public Ticket(State s) { this.s = s; this.version = s.version; s.affectedUnits = new LinkedHashSet<>(s.affectedUnits); }

    /** Factory: a new ticket, Open. */
    public static Ticket raise(State s, Instant now) {
        if (s.title == null || s.title.strip().length() < 3 || s.title.length() > 200) throw new DomainException.RuleViolated("bad-title", "Give a short title (3-200 characters)");
        if (s.description != null && s.description.length() > 10_000) throw new DomainException.RuleViolated("too-long", "The description is too long");
        if (Names.pick(CATEGORIES, s.category) == null) throw new DomainException.RuleViolated("bad-category", "Pick a category from the list");
        s.category = Names.pick(CATEGORIES, s.category);
        if (!PRIORITIES.contains(s.priority)) throw new DomainException.RuleViolated("bad-priority", "Pick a priority from the list");
        if (!"Unit".equals(s.scope) && !"Community".equals(s.scope)) throw new DomainException.RuleViolated("bad-scope", "A request is for a unit or the community");
        if ("Unit".equals(s.scope) && s.unit == null) throw new DomainException.RuleViolated("unit-required", "Say which unit");
        if ("Community".equals(s.scope) && (s.location == null || s.location.isBlank())) throw new DomainException.RuleViolated("location-required", "Say where in the community the problem is");
        s.id = s.id == null ? UUID.randomUUID() : s.id; s.title = s.title.strip(); s.status = TicketStatus.OPEN; s.createdAt = now;
        Ticket t = new Ticket(s);
        t.raise(new TicketRaised(s.id, s.community, s.unit, s.category, s.priority, s.scope, now));
        return t;
    }

    public void assign(MembershipId who, String name, Instant now) {
        if (s.status.finished() || s.status == TicketStatus.COMPLETED) throw new DomainException.RuleViolated("ticket-finished", "This ticket is " + s.status.label());
        if (who == null) {
            if (s.status != TicketStatus.ASSIGNED && s.status != TicketStatus.OPEN) throw new DomainException.RuleViolated("work-started", "Work has started: reassign instead of unassigning");
            s.assignee = null; s.assigneeName = null; s.assignedAt = null; move(TicketStatus.OPEN, now);
            return;
        }
        if (who.equals(s.assignee)) return;
        s.assignee = who; s.assigneeName = name; s.assignedAt = now;
        if (s.status == TicketStatus.OPEN) move(TicketStatus.ASSIGNED, now);
        raise(new TicketAssigned(s.id, s.community, who, s.category, now));
    }

    /** A status move; side effects (times, reason, reopen count) follow from it. */
    public void changeStatus(TicketStatus to, String reason, Instant now) {
        if (to == TicketStatus.ASSIGNED) throw new DomainException.RuleViolated("use-assign", "Assign someone to move a ticket to Assigned");
        if (to == TicketStatus.CANCELLED && (reason == null || reason.strip().length() < 3)) throw new DomainException.RuleViolated("reason-required", "Say why it is cancelled");
        if ((to == TicketStatus.IN_PROGRESS || to == TicketStatus.COMPLETED) && s.assignee == null) throw new DomainException.RuleViolated("unassigned", "Assign someone first");
        TicketStatus from = s.status;
        move(to, now);
        switch (to) {
            case IN_PROGRESS -> { if (s.startedAt == null) s.startedAt = now; if (from == TicketStatus.COMPLETED) s.completedAt = null; }
            case COMPLETED -> s.completedAt = now;
            case CLOSED -> s.closedAt = now;
            case CANCELLED -> { s.cancelledAt = now; s.cancelReason = reason.strip(); }
            case OPEN -> { if (from.finished()) { s.reopenCount++; s.closedAt = null; s.cancelledAt = null; s.cancelReason = null; s.completedAt = null; s.assignee = null; s.assigneeName = null; } }
            default -> { }
        }
    }

    private void move(TicketStatus to, Instant now) {
        if (s.status == to) return;
        if (!s.status.canMoveTo(to)) throw new DomainException.RuleViolated("bad-move", "A ticket that is " + s.status.label() + " cannot become " + to.label());
        TicketStatus from = s.status;
        s.status = to;
        raise(new TicketStatusChanged(s.id, s.community, from.label(), to.label(), now));
    }

    /** "Me too" on a community request: add or remove one unit. */
    public void affects(UnitId unit, boolean add) {
        if (!"Community".equals(s.scope)) throw new DomainException.RuleViolated("not-community", "Only a community request can be joined");
        if (s.status.finished()) throw new DomainException.RuleViolated("ticket-finished", "This request is " + s.status.label());
        if (add) s.affectedUnits.add(unit); else s.affectedUnits.remove(unit);
    }

    public void rate(int rating) {
        if (rating < 1 || rating > 5) throw new DomainException.RuleViolated("bad-rating", "Rate from 1 to 5");
        if (s.status != TicketStatus.COMPLETED && s.status != TicketStatus.CLOSED) throw new DomainException.RuleViolated("not-done", "Rate the work once it is done");
        s.residentRating = rating;
    }

    /** Field changes, already allowed field by field by TicketRules. A null leaves the field as it is. */
    public record Changes(String title, String description, String category, String subCategory, String priority, String location, String preferredTime,
                          LocalDate slaDueAt, Boolean awaitingParts, Money materialsCost, Boolean financial, LocalDate workDone) {}

    public void edit(Changes c) {
        if (s.status.finished()) throw new DomainException.RuleViolated("ticket-finished", "This ticket is " + s.status.label() + " - reopen it first");
        if (c.title() != null) { if (c.title().strip().length() < 3 || c.title().length() > 200) throw new DomainException.RuleViolated("bad-title", "Give a short title (3-200 characters)"); s.title = c.title().strip(); }
        if (c.description() != null) { if (c.description().length() > 10_000) throw new DomainException.RuleViolated("too-long", "The description is too long"); s.description = c.description(); }
        if (c.category() != null) { String k = Names.pick(CATEGORIES, c.category()); if (k == null) throw new DomainException.RuleViolated("bad-category", "Pick a category from the list"); s.category = k; }
        if (c.subCategory() != null) s.subCategory = c.subCategory().isBlank() ? null : c.subCategory().strip();
        if (c.priority() != null) { String k = Names.pick(PRIORITIES, c.priority()); if (k == null) throw new DomainException.RuleViolated("bad-priority", "Pick a priority from the list"); s.priority = k; }
        if (c.location() != null) {
            if ("Community".equals(s.scope) && c.location().isBlank()) throw new DomainException.RuleViolated("location-required", "Say where in the community the problem is");
            s.location = c.location().isBlank() ? null : c.location().strip();
        }
        if (c.preferredTime() != null) s.preferredTime = c.preferredTime().isBlank() ? null : c.preferredTime().strip();
        if (c.slaDueAt() != null) s.slaDueAt = c.slaDueAt();
        if (c.awaitingParts() != null) s.awaitingParts = c.awaitingParts();
        if (c.materialsCost() != null) { if (c.materialsCost().isNegative()) throw new DomainException.RuleViolated("bad-amount", "The cost cannot be negative"); s.materialsCost = c.materialsCost(); }
        if (c.financial() != null) s.financial = c.financial();
        if (c.workDone() != null) s.workDone = c.workDone();
    }

    public State state() { return s; }
    public UUID id() { return s.id; } public String shortId() { return s.shortId; } public TicketStatus status() { return s.status; } public TaskType taskType() { return s.taskType; }
    public UnitId unit() { return s.unit; } public BlockId block() { return s.block; } public String scope() { return s.scope; } public String category() { return s.category; }
    public MembershipId assignee() { return s.assignee; } public MembershipId raisedBy() { return s.raisedBy; } public Instant createdAt() { return s.createdAt; }
    public boolean community() { return "Community".equals(s.scope); }
    public boolean financial() { return s.financial; } public Approval approval() { return s.approval; } public String title() { return s.title; }
    /** Shortened numbers for logs; never used for decisions. */
    @Override public String toString() { return s.shortId + " " + s.status.label(); }
    public void numbered(String shortId) { s.shortId = shortId; }
}
