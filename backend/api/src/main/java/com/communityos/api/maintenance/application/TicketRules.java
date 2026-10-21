package com.communityos.api.maintenance.application;

import com.communityos.api.maintenance.domain.TaskType;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.maintenance.domain.TicketStatus;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Who may do what to a ticket - the server-side rules that used to live in the browser (ticketEngine.js) and the r76 rule book (TicketRules).
 *   coordinator   the Super Admin, committee (EC) members, the Facility Manager (MANAGE_TICKETS) and the MEP: run the queue
 *   field staff   staff whose role has a trade (Handyman · Plumbing ...): work their trade's tickets
 *   resident      their own units' tickets, "me too" on community requests
 */
public final class TicketRules {
    private TicketRules() {}
    static final Set<String> STAFF_CREATORS = Set.of("facility_manager", "handyman_mep");

    public static boolean coordinator(Caller c) {
        return c.isSuperAdmin() || c.category() == Caller.Category.EC || c.has(Permission.MANAGE_TICKETS) || c.roleCodes().contains("handyman_mep");
    }
    public static boolean fieldStaff(Caller c) { return c.category() == Caller.Category.Staff && c.trade() != null && !coordinator(c); }
    static boolean ownsUnit(Caller c, Ticket t) { return t.unit() != null && c.units().contains(t.unit()); }
    static boolean raisedIt(Caller c, Ticket t) { return c.membership() != null && c.membership().equals(t.raisedBy()); }
    static boolean assignedTo(Caller c, Ticket t) { return c.membership() != null && c.membership().equals(t.assignee()); }
    static boolean sameTrade(Caller c, Ticket t) { return c.trade() != null && com.communityos.api.shared.domain.Names.same(c.trade(), t.category()); }

    /** Which task types this caller may raise. Within staff only the Facility Manager and MEP raise tasks. */
    public static boolean mayRaise(Caller c, TaskType tt) {
        if (!tt.active()) return false;
        if (c.isSuperAdmin()) return true;
        if (c.category() == Caller.Category.Vendor || c.category() == Caller.Category.System) return false;
        if (c.category() == Caller.Category.Staff && c.roleCodes().stream().noneMatch(STAFF_CREATORS::contains)) return false;
        return switch (tt.creatorScope()) {
            case TaskType.ANYONE -> true;
            case TaskType.RESIDENT -> c.isResident();
            case TaskType.STAFF -> c.category() == Caller.Category.EC || c.category() == Caller.Category.Staff;
            default -> false;
        };
    }

    /** Which fields this caller may change on this ticket; throws with the list of the ones they may not. */
    static void checkEdit(Caller c, Ticket t, Ticket.Changes ch, boolean withinEditWindow) {
        List<String> asked = changed(ch);
        if (asked.isEmpty()) return;
        List<String> allowed;
        if (c.isResident()) {
            if (!ownsUnit(c, t) && !raisedIt(c, t)) throw new AccessDenied("You can only change your own requests");
            allowed = withinEditWindow ? List.of("description", "location", "preferredTime") : List.of("preferredTime");
        } else if (fieldStaff(c)) {
            if (!assignedTo(c, t) && !sameTrade(c, t)) throw new AccessDenied("This ticket is not in your queue");
            allowed = List.of("description", "awaitingParts", "materialsCost", "workDone", "preferredTime");
        } else if (coordinator(c)) {
            allowed = new ArrayList<>(List.of("title", "description", "category", "subCategory", "priority", "location", "preferredTime", "awaitingParts", "materialsCost", "workDone"));
            if (c.isSuperAdmin() || c.category() == Caller.Category.EC) allowed.add("slaDueAt");                         // once raised, only the EC moves the SLA
            if (c.isSuperAdmin() || c.has(Permission.SET_FINANCIAL_FLAG)) allowed.add("financial");
        } else throw new AccessDenied("You cannot change tickets");
        List<String> refused = asked.stream().filter((f) -> !allowed.contains(f)).toList();
        if (!refused.isEmpty()) {
            String why = c.isResident() && refused.contains("description") ? " (a request can be edited for 30 minutes after it is raised)" : "";
            throw new AccessDenied("You cannot change: " + String.join(", ", refused) + why);
        }
    }

    /** Who may assign: coordinators; field staff may take over (or hand to a colleague of the same trade) while work has not started. */
    static void checkAssign(Caller c, Ticket t) {
        if (coordinator(c)) return;
        if (fieldStaff(c) && sameTrade(c, t) && (t.status() == TicketStatus.OPEN || t.status() == TicketStatus.ASSIGNED)) return;
        throw new AccessDenied("You cannot assign this ticket");
    }

    static void checkStatus(Caller c, Ticket t, TicketStatus to, Set<String> finalApproverRoles) {
        boolean coord = coordinator(c), ec = c.isSuperAdmin() || c.category() == Caller.Category.EC;
        boolean owner = raisedIt(c, t) || (c.isResident() && ownsUnit(c, t) && !t.community());
        switch (to) {
            case IN_PROGRESS, ON_HOLD, COMPLETED -> { if (!(coord || assignedTo(c, t))) throw new AccessDenied("Only the assignee or the Facility Manager can update the work"); }
            case CLOSED -> {
                boolean approver = c.roleCodes().stream().anyMatch(finalApproverRoles::contains);
                if (!(ec || approver || (owner && t.status() == TicketStatus.COMPLETED))) throw new AccessDenied("Only the person who raised it (once it is Completed), an EC member or a final approver can close a ticket - not the assignee");
            }
            case CANCELLED -> { if (!(ec || owner)) throw new AccessDenied("Only the person who raised it or an EC member can cancel a ticket"); }
            case OPEN -> {
                if (t.status().finished() && !ec) throw new AccessDenied("Only EC members can reopen a closed ticket");
                if (!t.status().finished() && !coord) throw new AccessDenied("You cannot do that");
            }
            default -> throw new AccessDenied("You cannot do that");
        }
    }

    private static List<String> changed(Ticket.Changes ch) {
        List<String> out = new ArrayList<>();
        if (ch.title() != null) out.add("title"); if (ch.description() != null) out.add("description"); if (ch.category() != null) out.add("category");
        if (ch.subCategory() != null) out.add("subCategory"); if (ch.priority() != null) out.add("priority"); if (ch.location() != null) out.add("location");
        if (ch.preferredTime() != null) out.add("preferredTime"); if (ch.slaDueAt() != null) out.add("slaDueAt"); if (ch.awaitingParts() != null) out.add("awaitingParts");
        if (ch.materialsCost() != null) out.add("materialsCost"); if (ch.financial() != null) out.add("financial"); if (ch.workDone() != null) out.add("workDone");
        return out;
    }
}
