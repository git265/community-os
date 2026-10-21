package com.communityos.api.governance.application;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;

/** Who runs meetings and ballots, and who sees what. Voting itself is decided by the frozen roll, not by a role. */
public final class GovernancePolicy {
    private GovernancePolicy() {}
    /** Schedules meetings, writes minutes, drafts / opens / closes ballots: MANAGE_GOVERNANCE (the committee) and the super admin. */
    public static boolean manager(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_GOVERNANCE); }
    public static boolean member(Caller c) { return c.membership() != null && c.category() != Caller.Category.Vendor && c.category() != Caller.Category.System; }
    /** Internal meetings and draft ballots: the committee and the management staff, never residents. */
    public static boolean insider(Caller c) { return member(c) && !c.isResident(); }
    /** Owner names on a roll and who cast a unit's vote: the managers (a unit's own people see their own). */
    public static boolean seesVoters(Caller c) { return manager(c); }
}
