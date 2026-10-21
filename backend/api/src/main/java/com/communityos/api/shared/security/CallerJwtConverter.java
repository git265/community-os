package com.communityos.api.shared.security;

import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import java.util.UUID;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Turns a verified token into the request's Caller: the token only says WHO (person, community, membership); what they may do is read
 * from the database now (CallerLoader). A membership that was deactivated or moved is refused here (401), even with an unexpired token.
 */
public final class CallerJwtConverter implements Converter<Jwt, AbstractAuthenticationToken> {
    private final CallerLoader loader;
    public CallerJwtConverter(CallerLoader loader) { this.loader = loader; }

    @Override public AbstractAuthenticationToken convert(Jwt jwt) {
        try {
            PersonId person = new PersonId(UUID.fromString(jwt.getSubject()));
            CommunityId community = new CommunityId(UUID.fromString(String.valueOf(jwt.getClaims().get("cid"))));
            MembershipId membership = new MembershipId(UUID.fromString(String.valueOf(jwt.getClaims().get("mid"))));
            Caller caller = loader.load(person, community, membership).orElseThrow(() -> new BadCredentialsException("membership not active"));
            return new CallerAuthentication(caller, String.valueOf(jwt.getClaims().get("jti")));
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new BadCredentialsException("malformed token subject");
        }
    }
}
