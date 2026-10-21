package com.communityos.api.workforce.application;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;

/** Who clocks in, who supervises attendance and shifts, who keeps the site's rules. */
public final class WorkforcePolicy {
    private WorkforcePolicy() {}
    public static boolean member(Caller c) { return c.membership() != null && c.category() != Caller.Category.Vendor && c.category() != Caller.Category.System; }
    public static boolean reader(Caller c) { return member(c) && !c.isResident(); }
    /** Staff clock themselves in and out (residents and the committee do not). */
    public static boolean clocks(Caller c) { return c.membership() != null && c.category() == Caller.Category.Staff; }
    /** Sees everyone's attendance, corrects it, plans shifts, sets the site: MANAGE_FIELD_DUTIES, the committee, the super admin. */
    public static boolean supervisor(Caller c) { return c.isSuperAdmin() || c.isCommittee() || c.has(Permission.MANAGE_FIELD_DUTIES); }
    /** Holidays, timetabled services and calendar rules: supervisors and security managers. */
    public static boolean siteRules(Caller c) { return supervisor(c) || c.has(Permission.MANAGE_SECURITY); }
}
