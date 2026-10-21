package com.communityos.api.assets.application;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;

/** Who reads and keeps the asset registers, the stock and the logs. Residents see none of it except published audits. */
public final class AssetPolicy {
    private AssetPolicy() {}
    public static boolean member(Caller c) { return c.membership() != null && c.category() != Caller.Category.Vendor && c.category() != Caller.Category.System; }
    public static boolean reader(Caller c) { return member(c) && !c.isResident(); }
    /** The committee, the facility manager and MEP: equipment, stock, audits, the map. */
    public static boolean coordinator(Caller c) {
        return c.isSuperAdmin() || c.isCommittee() || c.roleCodes().contains("facility_manager") || c.roleCodes().contains("handyman_mep");
    }
    /** Readings and bills: the coordinators and the people who record meter readings or utility bills. */
    public static boolean writer(Caller c) { return coordinator(c) || c.hasAny(Permission.MANAGE_UTILITY_READINGS, Permission.MANAGE_UTILITY_BILLING); }
    /** An asset's name is quoted by tasks and the map: only the committee or the super admin renames one. */
    public static boolean renames(Caller c) { return c.isSuperAdmin() || c.isCommittee(); }
    /** Custom log types and import layouts: the super admin. */
    public static boolean admin(Caller c) { return c.isSuperAdmin(); }
}
