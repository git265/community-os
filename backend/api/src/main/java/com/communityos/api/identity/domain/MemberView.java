package com.communityos.api.identity.domain;

import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.time.Instant;
import java.util.List;
import java.util.Set;

/** A member of the community as lists and the detail screen show them. */
public record MemberView(MembershipId id, PersonId person, String displayName, String phone, String status, List<Role> roles, Set<UnitId> units,
                         Instant createdAt, Instant updatedAt, long version) {
    public record Role(String code, String name, boolean primary) {}
    public MemberView { roles = List.copyOf(roles); units = Set.copyOf(units); }
    public MemberView withPhone(String p) { return new MemberView(id, person, displayName, p, status, roles, units, createdAt, updatedAt, version); }
}
