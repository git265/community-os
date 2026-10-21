package com.communityos.api.shared.security;

import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import java.util.Optional;

/**
 * Port: builds the Caller for a verified token from the database - the member's CURRENT roles, permissions, units and blocks. Roles are not
 * put in the token, so a role taken away or a member deactivated takes effect within the cache time, not when the token expires.
 * Empty when the membership is not active, does not belong to that person, or the community is not active.
 */
public interface CallerLoader {
    Optional<Caller> load(PersonId person, CommunityId community, MembershipId membership);
    /** Forget the cached caller after their roles, units or status change. */
    void evict(MembershipId membership);
}
