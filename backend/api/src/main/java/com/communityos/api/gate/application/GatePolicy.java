package com.communityos.api.gate.application;

import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

/**
 * Who works the gate and who sees what of it:
 *   gate staff   the Super Admin, MANAGE_SECURITY, the security committee and security handymen: run the desk, see everything
 *   FM           the Facility Manager: crews, household staff and the registry, answers for the common area
 *   committee    sees the gate's records (oversight)
 *   resident     their own units' passes, visits and approvals; answers their own approvals
 */
public final class GatePolicy {
    private GatePolicy() {}
    static final Set<String> SECURITY_ROLES = Set.of("committee_security", "handyman_security");
    public static boolean gateStaff(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_SECURITY) || c.roleCodes().stream().anyMatch(SECURITY_ROLES::contains); }
    public static boolean fm(Caller c) { return c.roleCodes().contains("facility_manager"); }
    public static boolean gateOrFm(Caller c) { return gateStaff(c) || fm(c); }
    public static boolean oversees(Caller c) { return gateOrFm(c) || c.isCommittee() || c.category() == Caller.Category.System; }

    /** Rows with a unit: residents see their own units', the gate team and the committee all, others none. column = e.g. "p.unit_id". */
    public static <T> Spec<T> byUnit(Caller c, String column, Function<T, UnitId> unitOf) {
        if (oversees(c)) return Spec.all();
        if (c.isResident()) return Spec.in(column, c.units().stream().map(UnitId::value).map(UUID::toString).map(UUID::fromString).toList(), (t) -> unitOf.apply(t) != null && c.units().contains(unitOf.apply(t)));
        return Spec.none();
    }
}
