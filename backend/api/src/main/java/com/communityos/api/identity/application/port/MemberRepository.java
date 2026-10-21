package com.communityos.api.identity.application.port;

import com.communityos.api.identity.domain.MemberView;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Memberships of the caller's community (tenant connection: RLS keeps every statement inside it). */
public interface MemberRepository {
    record Filter(String q, String roleCode, String status) {}

    Page<MemberView> find(Spec<MemberView> scope, Filter filter, PageQuery page);
    Optional<MemberView> findById(MembershipId id, Spec<MemberView> scope);
    MembershipId insert(PersonId person, String displayName);
    /** Replaces the roles; false when the version no longer matches (someone else changed the member). */
    boolean replaceRoles(MembershipId id, List<UUID> roleIds, UUID primaryRoleId, long expectedVersion);
    boolean setStatus(MembershipId id, String status, long expectedVersion);
    void addOccupant(UnitId unit, PersonId person, String relation, String fullName, String phone);
}
