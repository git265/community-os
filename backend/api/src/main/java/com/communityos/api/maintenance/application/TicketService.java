package com.communityos.api.maintenance.application;

import com.communityos.api.maintenance.application.port.CommentRepository;
import com.communityos.api.maintenance.application.port.MaintenanceDirectory;
import com.communityos.api.maintenance.application.port.MaintenanceDirectory.Candidate;
import com.communityos.api.maintenance.application.port.TicketRepository;
import com.communityos.api.maintenance.domain.Comment;
import com.communityos.api.maintenance.domain.TaskType;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.maintenance.domain.TicketEvents.CommentAdded;
import com.communityos.api.maintenance.domain.TicketStatus;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;

/** Use cases for tickets and their discussion. Every read goes through TicketPolicy; every change through TicketRules first. */
public final class TicketService {
    public static final Duration EDIT_WINDOW = Duration.ofMinutes(30);

    public record RaiseTicket(UUID taskTypeId, String title, String description, UnitId unitId, String scope, String location, String category, String subCategory,
                              String priority, String preferredTime, LocalDate slaDueAt) {}

    private final TicketRepository tickets; private final CommentRepository comments; private final MaintenanceDirectory directory; private final DomainEvents events;
    private final AuditWriter audit; private final Tx tx; private final Clock clock; private final com.communityos.api.maintenance.application.port.TaskMoney money;
    private final TicketPolicy policy = new TicketPolicy();

    public TicketService(TicketRepository tickets, CommentRepository comments, MaintenanceDirectory directory, com.communityos.api.maintenance.application.port.TaskMoney money,
                         DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.tickets = tickets; this.comments = comments; this.directory = directory; this.money = money; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    // ---- reads ----------------------------------------------------------------------------------------------------------------------------
    public Page<Ticket> list(Caller c, TicketRepository.Filter f, PageQuery page) { return tickets.find(policy.readScope(c), f, page); }
    public Ticket get(Caller c, UUID id) { return tickets.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new); }
    public List<TaskType> taskTypes(Caller c) { return directory.taskTypes().stream().filter((t) -> t.active() && (TicketPolicy.canSeeInternal(c) || t.residentVisible())).toList(); }

    /** The people this ticket can be given to (the "Assign to" list), for those who may assign it. */
    public List<Candidate> assignees(Caller c, UUID id) {
        Ticket t = get(c, id);
        TicketRules.checkAssign(c, t);
        return directory.candidates(t.category(), t.taskType() != null && t.taskType().internal());
    }

    // ---- raise ------------------------------------------------------------------------------------------------------------------------------
    public Ticket raise(Caller c, RaiseTicket cmd) {
        TaskType type = cmd.taskTypeId() == null
            ? directory.taskTypes().stream().filter(TaskType::residentDefault).filter((t) -> TicketRules.mayRaise(c, t)).findFirst()
                .orElseThrow(() -> new DomainException.RuleViolated("task-type-required", "Choose the kind of task"))
            : directory.taskType(cmd.taskTypeId()).orElseThrow(() -> new DomainException.RuleViolated("unknown-task-type", "There is no such task type"));
        if (!TicketRules.mayRaise(c, type)) throw new AccessDenied("You cannot raise \"" + type.name() + "\" tasks");

        Ticket.State s = new Ticket.State();
        s.community = c.community(); s.taskType = type; s.title = cmd.title(); s.description = blankToNull(cmd.description()); s.category = cmd.category();
        s.subCategory = blankToNull(cmd.subCategory()); s.priority = cmd.priority() == null ? "Medium" : cmd.priority(); s.scope = cmd.scope() == null ? "Unit" : cmd.scope();
        s.location = blankToNull(cmd.location()); s.preferredTime = blankToNull(cmd.preferredTime());
        s.raisedBy = c.membership(); s.raisedByName = c.displayName(); s.raisedByRole = c.roleCodes().stream().findFirst().orElse(null);

        UnitId unit = cmd.unitId();
        if (c.isResident()) {
            if (unit == null && c.units().size() == 1) unit = c.units().iterator().next();
            if (unit == null || !c.units().contains(unit)) throw new AccessDenied(c.units().isEmpty() ? "Your account is not linked to a unit yet" : "Raise requests for your own unit only");
            if (cmd.slaDueAt() != null) throw new AccessDenied("The SLA is set by the committee");
        } else if (cmd.slaDueAt() != null && cmd.slaDueAt().isBefore(LocalDate.now(clock))) {
            throw new DomainException.RuleViolated("bad-sla", "SLA due must be today or a future date");
        }
        if (unit != null) {
            MaintenanceDirectory.UnitRef u = directory.unit(unit).orElseThrow(AccessDenied.NotVisible::new);
            if (c.isBlockLimited() && (u.block() == null || !c.blocks().contains(u.block())) && !"Community".equals(s.scope)) throw new AccessDenied.NotVisible();
            s.unit = u.id(); s.unitNo = u.unitNo(); s.block = u.block();
        }
        s.slaDueAt = c.isResident() ? null : cmd.slaDueAt();
        Instant now = clock.instant();
        Ticket t = Ticket.raise(s, now);
        // a role-queue task with exactly one clocked-in person in its trade goes straight to them
        if (type.queue()) {
            List<Candidate> on = directory.candidates(t.category(), false).stream().filter((x) -> "Field staff".equals(x.kind()) && x.clockedIn()).toList();
            if (on.size() == 1) t.assign(on.get(0).id(), on.get(0).name(), now);
        }
        return tx.inTx(() -> {
            tickets.insert(t);
            events.publish(t.pullEvents());
            audit.write(c, AuditWriter.Action.Create, "maintenance.ticket", t.id(), t.shortId(), unitValue(t), "Raised " + t.shortId() + ": " + s.title,
                List.of(new AuditWriter.Change("status", null, t.status().label())));
            return t;
        });
    }

    // ---- change -----------------------------------------------------------------------------------------------------------------------------
    public Ticket edit(Caller c, UUID id, long version, Ticket.Changes ch) {
        return change(c, id, version, "Updated", (t) -> {
            boolean window = Duration.between(t.createdAt(), clock.instant()).compareTo(EDIT_WINDOW) < 0;
            TicketRules.checkEdit(c, t, ch, window);
            if (ch.slaDueAt() != null && ch.slaDueAt().isBefore(LocalDate.now(clock))) throw new DomainException.RuleViolated("bad-sla", "SLA due must be today or a future date");
            t.edit(ch);
        });
    }

    public Ticket assign(Caller c, UUID id, long version, MembershipId assignee) {
        return change(c, id, version, assignee == null ? "Unassigned" : "Assigned", (t) -> {
            TicketRules.checkAssign(c, t);
            if (assignee == null) { if (!TicketRules.coordinator(c)) throw new AccessDenied("Only the Facility Manager or the EC can unassign"); t.assign(null, null, clock.instant()); return; }
            Candidate who = directory.candidates(t.category(), t.taskType() != null && t.taskType().internal()).stream().filter((x) -> x.id().equals(assignee)).findFirst()
                .orElseThrow(() -> new DomainException.RuleViolated("not-eligible", "That person cannot take " + t.category() + " tickets"));
            if (TicketRules.fieldStaff(c) && !Objects.equals(who.trade(), c.trade())) throw new AccessDenied("Hand it to someone of your own trade, or ask the Facility Manager");
            t.assign(who.id(), who.name(), clock.instant());
        });
    }

    public Ticket changeStatus(Caller c, UUID id, long version, TicketStatus to, String reason) {
        return change(c, id, version, "Moved to " + to.label(), (t) -> {
            TicketRules.checkStatus(c, t, to, directory.finalApproverRoles());
            if (t.financial() && (to == TicketStatus.CLOSED || to == TicketStatus.CANCELLED)) moneyAllows(t, to);
            t.changeStatus(to, reason, clock.instant());
        });
    }

    /** A resident joins (or leaves) someone else's community request with their own unit. */
    public Ticket meToo(Caller c, UUID id, UnitId unit, boolean join) {
        if (!c.hasHome()) throw new AccessDenied("Only residents add their unit to a request");
        UnitId mine = unit != null ? unit : c.units().stream().findFirst().orElseThrow(() -> new AccessDenied("Your account is not linked to a unit yet"));
        if (!c.units().contains(mine)) throw new AccessDenied("You can only add your own unit");
        return tx.inTx(() -> {
            Ticket t = tickets.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
            t.affects(mine, join);
            if (!tickets.save(t)) throw new DomainException.Conflict("Ticket " + t.shortId());
            audit.write(c, AuditWriter.Action.Update, "maintenance.ticket", t.id(), t.shortId(), mine.value(), (join ? "Me too on " : "Left ") + t.shortId(), List.of());
            return t;
        });
    }

    public Ticket rate(Caller c, UUID id, int rating) {
        return tx.inTx(() -> {
            Ticket t = tickets.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
            if (!(c.hasHome() && (TicketRules.ownsUnit(c, t) || TicketRules.raisedIt(c, t)))) throw new AccessDenied("Only the resident who asked can rate the work");
            t.rate(rating);
            if (!tickets.save(t)) throw new DomainException.Conflict("Ticket " + t.shortId());
            audit.write(c, AuditWriter.Action.Update, "maintenance.ticket", t.id(), t.shortId(), unitValue(t), "Rated " + t.shortId() + " " + rating + "/5",
                List.of(new AuditWriter.Change("residentRating", null, String.valueOf(rating))));
            return t;
        });
    }

    private Ticket change(Caller c, UUID id, long version, String what, Consumer<Ticket> work) {
        return tx.inTx(() -> {
            Ticket t = tickets.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
            if (t.version() != version) throw new DomainException.Conflict("Ticket " + t.shortId());
            String before = t.status().label();
            work.accept(t);
            if (!tickets.save(t)) throw new DomainException.Conflict("Ticket " + t.shortId());
            events.publish(t.pullEvents());
            List<AuditWriter.Change> diff = new ArrayList<>();
            if (!before.equals(t.status().label())) diff.add(new AuditWriter.Change("status", before, t.status().label()));
            audit.write(c, AuditWriter.Action.Update, "maintenance.ticket", t.id(), t.shortId(), unitValue(t), what + " " + t.shortId(), diff);
            return t;
        });
    }

    // ---- discussion ---------------------------------------------------------------------------------------------------------------------------
    public List<Comment> comments(Caller c, UUID ticketId) {
        get(c, ticketId);
        return comments.ofTicket(ticketId, TicketPolicy.canSeeInternal(c));
    }

    public List<Comment> recentComments(Caller c, int limit) { return comments.recent(policy.readScope(c), TicketPolicy.canSeeInternal(c), limit); }

    public Comment comment(Caller c, UUID ticketId, String body, String visibility) {
        String vis = visibility == null ? "Public" : visibility;
        if (!vis.equals("Public") && !vis.equals("Internal")) throw new DomainException.RuleViolated("bad-visibility", "Public or Internal");
        if (vis.equals("Internal") && !TicketPolicy.canSeeInternal(c)) throw new AccessDenied("Residents cannot post internal comments");
        if (body == null || body.isBlank() || body.length() > 5000) throw new DomainException.RuleViolated("bad-comment", "Write a comment (up to 5000 characters)");
        if (c.membership() == null) throw new AccessDenied("Sign in to comment");
        return tx.inTx(() -> {
            Ticket t = get(c, ticketId);
            Comment out = comments.insert(ticketId, c.membership(), vis, body.strip());
            events.publish(List.of(new CommentAdded(ticketId, out.id(), c.community(), vis, clock.instant())));
            audit.write(c, AuditWriter.Action.Create, "maintenance.ticket_comment", out.id(), out.shortId(), unitValue(t), vis + " comment on " + t.shortId(), List.of());
            return out;
        });
    }

    /** A task with money on it closes only once no release is waiting or unpaid, and is cancelled only when nothing is released or paid. */
    private void moneyAllows(Ticket t, TicketStatus to) {
        var m = money.position(t.id());
        if (to == TicketStatus.CLOSED && m.openReleases() > 0)
            throw new DomainException.RuleViolated("open-releases", m.openReleases() + (m.openReleases() == 1 ? " release is" : " releases are") + " still waiting or unpaid - pay or cancel " + (m.openReleases() == 1 ? "it" : "them") + " before closing the task");
        if (to == TicketStatus.CANCELLED && m.committed().amount().compareTo(java.math.BigDecimal.valueOf(0.5)) > 0)
            throw new DomainException.RuleViolated("money-committed", m.committed().amount().toPlainString() + " is released or paid on this task - cancel the releases and reverse the payments before cancelling it");
    }

    private static UUID unitValue(Ticket t) { return t.unit() == null ? null : t.unit().value(); }
    private static String blankToNull(String s) { return s == null || s.isBlank() ? null : s.strip(); }
}
