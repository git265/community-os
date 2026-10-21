package com.communityos.api.identity.application.port;

import com.communityos.api.identity.domain.Phone;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import java.util.List;
import java.util.Optional;

/** People and their memberships across communities (the platform connection: sign-in happens before a community is chosen). */
public interface PersonDirectory {
    record PersonRef(PersonId id, String fullName) {}
    record MembershipRef(CommunityId community, String communityName, MembershipId membership, String displayName) {}

    Optional<PersonRef> findActiveByPhone(Phone phone);
    /** Active memberships in active communities. */
    List<MembershipRef> activeMemberships(PersonId person);
    boolean isActive(PersonId person, CommunityId community, MembershipId membership);
    /** The person with this phone, created if new (a phone is one person across all communities). */
    PersonId findOrCreate(Phone phone, String fullName);
}
