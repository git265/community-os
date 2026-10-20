package com.communityos.security;

import java.util.Arrays;
import java.util.List;

/** The role and permission tests every rule is built from (the helpers at the top of src/lib/security/authz.js). */
public final class Perms {
    private Perms() {}

    public static boolean has(Principal p, String perm) { return p != null && p.has(perm); }
    public static boolean anyPerm(Principal p, String... perms) { return p != null && Arrays.stream(perms).anyMatch(p::has); }
    public static boolean anyPerm(Principal p, List<String> perms) { return p != null && perms.stream().anyMatch(p::has); }

    public static boolean isAdmin(Principal p) { return p != null && "super_admin".equals(p.roleId()); }
    public static boolean isResident(Principal p) { return p != null && "Resident".equals(p.category()); }
    public static boolean isHandyman(Principal p) { return p != null && p.roleId() != null && p.roleId().startsWith("handyman_"); }
    public static boolean isEC(Principal p) { return p != null && "EC".equals(p.category()); }
    public static boolean isStaff(Principal p) { return p != null && "Staff".equals(p.category()); }
    public static boolean isFacilityManager(Principal p) { return p != null && "facility_manager".equals(p.roleId()); }

    /** The two people who coordinate the facilities contract day to day: Facility Manager + MEP. */
    public static boolean isCoordinator(Principal p) { return p != null && ("facility_manager".equals(p.roleId()) || "handyman_mep".equals(p.roleId())); }
    /** Who may see and collect quotations: EC, Facility Manager, MEP. */
    public static boolean isQuoteRole(Principal p) { return isEC(p) || isCoordinator(p); }

    public static boolean canCultural(Principal p) { return anyPerm(p, "MANAGE_CULTURAL", "MANAGE_LEDGER"); }
    public static boolean canCulturalEvents(Principal p) { return anyPerm(p, "MANAGE_CULTURAL"); }
    public static boolean canManageReadings(Principal p) { return isEC(p) || has(p, "MANAGE_UTILITY_READINGS") || has(p, "MANAGE_UTILITY_BILLING"); }

    /** Gate staff: the security committee / EC and the guards (MANAGE_SECURITY). */
    public static boolean gateStaff(Principal p) { return !isResident(p) && (isEC(p) || anyPerm(p, "MANAGE_SECURITY")); }
    /** Gate staff plus the Facility Manager (who owns crew work orders and approves unlisted workers). */
    public static boolean gateOrFM(Principal p) { return gateStaff(p) || (!isResident(p) && anyPerm(p, "MANAGE_FIELD_DUTIES")); }

    public static boolean canAssetsRead(Principal p) { return !isResident(p); }
    public static boolean canAssetsWrite(Principal p) { return isQuoteRole(p) || anyPerm(p, "MANAGE_UTILITY_READINGS", "MANAGE_UTILITY_BILLING"); }
    public static boolean canEventWork(Principal p) { return isQuoteRole(p) || anyPerm(p, "MANAGE_CULTURAL", "MANAGE_AMENITIES"); }
    public static boolean canReports(Principal p) { return isEC(p) || isFacilityManager(p) || anyPerm(p, "MANAGE_NOTIFICATIONS"); }

    /** Roles that give the final (second-step) approval; configurable (Maintenance -> Final approvers). The Super Admin always may. */
    public static boolean isSecondApprover(Principal p, RuleContext ctx) { return p != null && (isAdmin(p) || ctx.secondStepRoles().contains(p.roleId())); }

    public static final List<String> SETTINGS_EDITORS = List.of("president", "treasurer");
}
