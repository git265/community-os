package com.communityos.api.shared.security;

import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.util.EnumSet;
import java.util.Objects;
import java.util.Set;

/**
 * Who is calling, resolved by the SERVER for every request: from the verified access token (person, membership, community) plus the
 * community's current roles, permissions, units and blocks read from the database. Nothing here comes from the request body or headers.
 */
public record Caller(PersonId person, MembershipId membership, CommunityId community, String displayName, Category category,
                     Set<String> roleCodes, Set<Permission> permissions, Set<UnitId> units, Set<BlockId> blocks, String trade, Set<java.util.UUID> roleIds) {

    public enum Category { EC, Staff, Resident, Vendor, System }

    public Caller {
        Objects.requireNonNull(community, "community");
        Objects.requireNonNull(category, "category");
        roleCodes = Set.copyOf(roleCodes);
        permissions = permissions.isEmpty() ? Set.of() : Set.copyOf(EnumSet.copyOf(permissions));
        units = Set.copyOf(units);
        blocks = Set.copyOf(blocks);
        roleIds = roleIds == null ? Set.of() : Set.copyOf(roleIds);
    }

    public boolean has(Permission p) { return permissions.contains(p); }
    public boolean hasAny(Permission... ps) { for (Permission p : ps) if (has(p)) return true; return false; }
    public boolean isSuperAdmin() { return roleCodes.contains("super_admin"); }
    public boolean isResident() { return category == Category.Resident; }
    public boolean isCommittee() { return category == Category.EC; }
    /**
     * Lives in or owns a unit here. A committee member or staff member who is also an owner does everything for their own unit that any
     * owner does (pays its bills, books for it, answers its gate, raises its requests, pledges, reviews), on top of their role.
     */
    public boolean hasHome() { return category != Category.Vendor && units != null && !units.isEmpty(); }
    public boolean ownsUnit(UnitId u) { return u != null && units != null && units.contains(u); }
    public boolean isBlockLimited() { return !blocks.isEmpty() && !isSuperAdmin() && !isResident(); }
    /** "Name (Role)" as written in the audit trail at the time. */
    public String label() { return displayName + " (" + String.join(", ", roleCodes) + ")"; }
}
