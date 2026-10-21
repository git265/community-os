package com.communityos.api.vendor.application;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;

/** Who keeps the vendor register, who discusses vendors, who moderates the residents' service directory. */
public final class VendorPolicy {
    private VendorPolicy() {}
    /** The vendor register and service lines: MANAGE_VENDORS and the super admin write; residents and vendors do not read it. */
    public static boolean manager(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_VENDORS); }
    public static boolean reader(Caller c) { return member(c) && !c.isResident(); }
    /** The internal discussion on a vendor: the committee, the facility manager and MEP, and the vendor managers. */
    public static boolean discusses(Caller c) {
        return manager(c) || c.isCommittee() || c.roleCodes().contains("facility_manager") || c.roleCodes().contains("handyman_mep");
    }
    public static boolean member(Caller c) { return c.membership() != null && c.category() != Caller.Category.Vendor && c.category() != Caller.Category.System; }
    /** Hides or removes anyone's directory entries and reviews: the committee, forum moderators and the super admin. */
    public static boolean moderator(Caller c) { return c.isSuperAdmin() || c.isCommittee() || c.has(Permission.MODERATE_FORUM); }
}
