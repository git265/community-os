package com.communityos.api.identity.application.port;

import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import java.time.Instant;

/** Issues the short-lived bearer token (ES256 JWT, 10 minutes). */
public interface TokenIssuer {
    record AccessToken(String value, Instant expiresAt) {}
    AccessToken issue(PersonId person, CommunityId community, MembershipId membership);
}
