package com.communityos.service;

import com.communityos.config.AppProperties;
import com.communityos.web.Names;
import java.util.Collection;
import java.util.List;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

/**
 * Decides which community a request is for. The browser sends X-Community-Id; in `jwt` and `local` mode that value MUST be one the
 * signed-in token allows (claim app.security.tenant-claim, a text or a list), so one community can never read another.
 */
@Component
public class TenantGuard {
    private final AppProperties.Security cfg;

    public TenantGuard(AppProperties props) { this.cfg = props.security(); }

    public String resolve(String header, Authentication who) {
        String tenant = Names.tenant(header);
        if ("jwt".equals(cfg.mode()) && who instanceof JwtAuthenticationToken jwt) {
            Object claim = jwt.getToken().getClaims().get(cfg.tenantClaim());
            List<?> allowed = claim instanceof Collection<?> c ? List.copyOf(c) : claim == null ? List.of() : List.of(claim);
            boolean platformAdmin = allowed.contains("*");
            if (!platformAdmin && !allowed.contains(tenant)) throw new AccessDeniedException("Your sign-in does not cover this community.");
        }
        if ("local".equals(cfg.mode()) && who instanceof com.communityos.auth.LocalAuthentication la) {
            Object claim = la.claims().get(cfg.tenantClaim());
            List<?> allowed = claim instanceof Collection<?> c ? List.copyOf(c) : claim == null ? List.of() : List.of(claim);
            if (!allowed.contains("*") && !allowed.contains(tenant)) throw new AccessDeniedException("Your sign-in does not cover this community.");
        }
        return tenant;
    }
}
