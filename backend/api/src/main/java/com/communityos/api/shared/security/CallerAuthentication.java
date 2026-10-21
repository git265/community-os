package com.communityos.api.shared.security;

import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

/** The authenticated request: the principal is the server-resolved Caller (not the token's claims). */
public final class CallerAuthentication extends AbstractAuthenticationToken {
    private final Caller caller;
    private final String tokenId;

    public CallerAuthentication(Caller caller, String tokenId) {
        super(caller.permissions().stream().map((p) -> new SimpleGrantedAuthority("PERM_" + p.name())).toList());
        this.caller = caller; this.tokenId = tokenId;
        setAuthenticated(true);
    }
    @Override public Object getCredentials() { return ""; }
    @Override public Object getPrincipal() { return caller; }
    @Override public String getName() { return caller.membership() == null ? "system" : caller.membership().toString(); }
    public Caller caller() { return caller; }
    public String tokenId() { return tokenId; }
}
