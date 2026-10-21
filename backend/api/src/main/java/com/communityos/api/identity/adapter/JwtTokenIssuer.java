package com.communityos.api.identity.adapter;

import com.communityos.api.identity.application.port.TokenIssuer;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.security.JwtCodec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Access token claims: sub (person), cid (community), mid (membership), iat, nbf, exp, jti. No roles: those are read per request. */
public final class JwtTokenIssuer implements TokenIssuer {
    private final JwtCodec codec; private final Duration ttl; private final Clock clock;
    public JwtTokenIssuer(JwtCodec codec, Duration ttl, Clock clock) { this.codec = codec; this.ttl = ttl; this.clock = clock; }

    @Override public AccessToken issue(PersonId person, CommunityId community, MembershipId membership) {
        Instant now = clock.instant();
        Instant exp = now.plus(ttl);
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("sub", person.toString()); c.put("cid", community.toString()); c.put("mid", membership.toString());
        c.put("iat", now.getEpochSecond()); c.put("nbf", now.getEpochSecond()); c.put("exp", exp.getEpochSecond()); c.put("jti", UUID.randomUUID().toString());
        return new AccessToken(codec.sign(c), exp);
    }
}
