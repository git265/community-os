package com.communityos.security;

import java.util.List;
import java.util.Set;

/**
 * Who is calling: the claims the filter chain resolved for this request (token -> user -> role). The rule book reads only this.
 * Mirrors the `principal` object of src/lib/security/principal.js.
 */
public record Principal(String roleId, Role role, String name, String unit, List<String> blocks, List<String> extraRoleIds,
                        String community, String userId, String phone, String email, List<String> units) {

    /** A role: category is EC, Staff or Resident; permissions are the ids the role holds (Roles & Permissions). */
    public record Role(String id, String name, String category, Set<String> permissions) {}

    public Principal {
        unit = unit == null ? "" : unit;
        blocks = blocks == null ? List.of() : List.copyOf(blocks);
        extraRoleIds = extraRoleIds == null ? List.of() : List.copyOf(extraRoleIds);
        // every unit of the person (the record's units); `unit` is the one they are acting for. A principal built from one unit has just that one.
        units = units == null || units.isEmpty() ? (unit.isEmpty() ? List.of() : List.of(unit)) : List.copyOf(units);
    }

    public Principal(String roleId, Role role, String name, String unit, List<String> blocks, List<String> extraRoleIds,
                     String community, String userId, String phone, String email) {
        this(roleId, role, name, unit, blocks, extraRoleIds, community, userId, phone, email, null);
    }

    public Principal(String roleId, Role role, String name, String unit, List<String> blocks) {
        this(roleId, role, name, unit, blocks, List.of(), "", "", "", "");
    }

    public String category() { return role == null ? null : role.category(); }
    public boolean has(String permission) { return role != null && role.permissions() != null && role.permissions().contains(permission); }
    /** "Name (Role)" as shown in the audit trail and on record stamps. */
    public String label() {
        String roleName = role != null && role.name() != null ? role.name() : roleId;
        return name != null && name.equals(roleName) ? name : name + " (" + roleName + ")";
    }
}
