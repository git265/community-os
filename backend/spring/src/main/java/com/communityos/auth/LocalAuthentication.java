package com.communityos.auth;

import java.util.List;
import java.util.Map;
import org.springframework.security.authentication.AbstractAuthenticationToken;

/** A request that carried a valid local access token (app.security.mode=local): its checked claims. Who the person is in a community is decided later (PrincipalResolver). */
public class LocalAuthentication extends AbstractAuthenticationToken {
    private final Map<String, Object> claims;

    public LocalAuthentication(Map<String, Object> claims) {
        super(List.of());
        this.claims = Map.copyOf(claims);
        setAuthenticated(true);
    }

    public Map<String, Object> claims() { return claims; }
    @Override public Object getCredentials() { return ""; }
    @Override public Object getPrincipal() { return String.valueOf(claims.get("sub")); }
}
