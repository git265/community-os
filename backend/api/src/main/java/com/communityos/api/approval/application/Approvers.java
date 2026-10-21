package com.communityos.api.approval.application;

import com.communityos.api.approval.domain.Plan;
import com.communityos.api.shared.security.Caller;
import java.util.Set;

/**
 * Who counts as an approver in this community: EC members, the final approvers (roles set under Maintenance -> Final approval) and the Super
 * Admin. finalCanDecideEc = an EC member who is also a final approver may decide the EC step too; separate = one person approves one step only,
 * and never their own request.
 */
public record Approvers(Set<String> finalRoles, boolean finalCanDecideEc, boolean separate) {
    public Approvers { finalRoles = Set.copyOf(finalRoles); }

    public boolean isAdmin(Caller c) { return c.isSuperAdmin(); }
    public boolean isFinal(Caller c) { return c.roleCodes().stream().anyMatch(finalRoles::contains); }
    public boolean isEc(Caller c) { return c.isCommittee() && (finalCanDecideEc || isAdmin(c) || !isFinal(c)); }

    public boolean matches(Plan.Approver a, Caller c) {
        String me = c.membership() == null ? "" : c.membership().toString();
        return switch (a.kind()) {
            case "group" -> Plan.Group.EC_MEMBERS.label.equals(a.value()) ? isEc(c) : Plan.Group.FINAL_APPROVERS.label.equals(a.value()) && isFinal(c);
            case "role" -> c.roleCodes().contains(a.value());
            case "user" -> me.equals(a.value());
            default -> false;
        };
    }
    public boolean eligible(Plan.Step s, Caller c) { return s != null && (isAdmin(c) || s.approvers().stream().anyMatch((a) -> matches(a, c))); }

    /** Why this caller may not decide the plan's waiting step now (null = they may). requester = the membership id of who asked for it. */
    public String whyNot(Plan plan, Caller c, String requester) {
        Plan.Position p = plan.position();
        if (p.state() != Plan.State.PENDING) return p.state() == Plan.State.REJECTED ? "This was rejected" : "Nothing is waiting for a decision";
        if (!eligible(p.step(), c)) return "Only " + who(p.step()) + " can decide the step \"" + p.step().name() + "\"";
        String me = c.membership() == null ? "" : c.membership().toString();
        if (p.step().approvedBy().contains(me)) return "You have already approved this step";
        if (separate && !isAdmin(c)) {
            if (requester != null && requester.equals(me)) return "You cannot approve your own request";
            for (Plan.Step s : plan.steps()) if (s != p.step() && s.approvedBy().contains(me)) return "You approved another step of this - someone else must decide this one";
        }
        return null;
    }
    public static String who(Plan.Step s) {
        return String.join(" or ", s.approvers().stream().map((a) -> a.kind().equals("role") ? "the " + a.value().replace('_', ' ') : a.value()).toList()) + (s.needed() > 1 ? " (any " + s.needed() + ")" : "");
    }
}
