package com.communityos.api.shared.security;

import java.util.Map;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/** Spring Security's bearer-token decoder, backed by JwtCodec (ES256 only, issuer / audience / expiry checked). */
public final class CallerJwtDecoder implements JwtDecoder {
    private final JwtCodec codec;
    public CallerJwtDecoder(JwtCodec codec) { this.codec = codec; }

    @Override public Jwt decode(String token) {
        Map<String, Object> claims;
        try { claims = codec.verify(token); } catch (JwtCodec.InvalidToken e) { throw new BadJwtException("invalid access token"); }
        Jwt.Builder b = Jwt.withTokenValue(token).header("alg", "ES256")
            .issuedAt(JwtCodec.instant(claims, "iat")).expiresAt(JwtCodec.instant(claims, "exp"));
        claims.forEach((k, v) -> { if (!k.equals("iat") && !k.equals("exp")) b.claim(k, v); });
        return b.build();
    }
}
