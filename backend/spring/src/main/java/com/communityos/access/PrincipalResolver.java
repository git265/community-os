package com.communityos.access;

import com.communityos.config.AppProperties;
import com.communityos.domain.QuerySpec;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

/**
 * Turns the signed-in caller into the {@link Principal} the rule book reads: who they are in THIS community, in which role, for which villa.
 *
 *   jwt      the token proves who the person is; the community's own `users` record says which role they hold (matched by the
 *            token's subject, phone or email, in the order app.security.user-match). A sign-in with no record is told to contact the
 *            office; an account is never created automatically. A role the person does not hold cannot be asked for.
 *   local    phone sign-in with one-time codes on this server (com.communityos.auth): the token names a session, which must still be live;
 *            the person's role and villa come from the session and the `users` record, never from the token alone.
 *   api-key / none   trusted internal callers (a script, local development): they act as the Super Admin under a fixed name.
 */
@Component
public class PrincipalResolver {
    private final AppProperties.Security cfg;
    private final DocumentRepository repo;
    private final org.springframework.beans.factory.ObjectProvider<com.communityos.auth.AuthService> auth;

    public PrincipalResolver(AppProperties props, DocumentRepository repo) { this(props, repo, null); }

    @org.springframework.beans.factory.annotation.Autowired
    public PrincipalResolver(AppProperties props, DocumentRepository repo, org.springframework.beans.factory.ObjectProvider<com.communityos.auth.AuthService> auth) {
        this.cfg = props.security(); this.repo = repo; this.auth = auth;
    }

    public Principal resolve(Authentication who, String tenant, CommunityMeta meta) {
        if ("local".equals(cfg.mode())) {   // phone sign-in on this server: the session must still be live and the users row still active
            if (!(who instanceof com.communityos.auth.LocalAuthentication la) || auth == null) throw new com.communityos.auth.AuthException(401, "Sign in to continue.", "unauthenticated");
            com.communityos.auth.AuthService.LocalUser u = auth.getObject().principal(la.claims(), tenant);
            return build(u.roleId(), u.name(), u.unit(), u.units(), u.blocks(), tenant, u.userId(), u.phone(), u.email(), meta);
        }
        if ("jwt".equals(cfg.mode())) {
            if (!(who instanceof JwtAuthenticationToken jwt)) throw new AccessDeniedException("Sign in to continue.");
            return fromToken(jwt.getToken().getClaims(), tenant, meta);
        }
        String name = "api-key".equals(cfg.mode()) ? "API key" : "Local development";
        return build("super_admin", name, "", List.of(), List.of(), tenant, "system:" + cfg.mode(), "", "", meta);
    }

    private Principal fromToken(Map<String, Object> claims, String tenant, CommunityMeta meta) {
        JsonNode u = findUser(claims, tenant);
        if (u == null) throw new AccessDeniedException("You are signed in, but this community has no account for you yet. Please contact the community office.");
        List<String> roles = new ArrayList<>();
        if (Js.truthy(u, "roleId")) roles.add(Js.str(u, "roleId"));
        for (JsonNode r : Js.list(u, "extraRoleIds")) if (r.isTextual() && !r.asText().isEmpty()) roles.add(r.asText());
        if (roles.isEmpty()) throw new AccessDeniedException("Your account has no role yet. Please contact the community office.");
        Object asked = claims.get("role") != null ? claims.get("role") : claims.get("roleId");
        String roleId = asked != null && roles.contains(String.valueOf(asked)) ? String.valueOf(asked) : roles.get(0);
        List<String> units = Js.strings(u, "units");
        return build(roleId, Js.str(u, "name"), units.isEmpty() ? "" : units.get(0), units, Js.strings(u, "blocks"), tenant,
                Js.str(u, "id"), Js.str(u, "phone"), Js.str(u, "email"), meta);
    }

    private Principal build(String roleId, String name, String unit, List<String> units, List<String> blocks, String tenant,
                            String userId, String phone, String email, CommunityMeta meta) {
        Principal.Role role = meta.catalog().role(roleId);
        if (role == null) throw new AccessDeniedException("Your role is not set up in this community.");   // an unknown role can do nothing
        return new Principal(roleId, role, name, unit, blocks, List.of(), tenant, userId, phone, email, units);
    }

    // ---- matching a sign-in to a users record ------------------------------------------------------------------------------

    private JsonNode findUser(Map<String, Object> claims, String tenant) {
        String sub = claims.get("sub") == null ? "" : String.valueOf(claims.get("sub"));
        String phone = claims.get("phone_number") == null ? "" : phoneKey(String.valueOf(claims.get("phone_number")));
        String email = claims.get("email") == null ? "" : String.valueOf(claims.get("email")).toLowerCase(Locale.ROOT);
        List<JsonNode> all = null;
        for (String how : cfg.userMatch().split(",")) {
            switch (how.trim()) {
                case "subject" -> {
                    if (sub.isEmpty()) break;
                    JsonNode hit = active(repo.query(tenant, "users", new QuerySpec(1, 5, "", "asc", "", List.of(), "", "", "", "", "", "", Map.of("authSubject", List.of(sub)))).rows(), (x) -> sub.equals(Js.text(x, "authSubject")));
                    if (hit != null) return hit;
                }
                case "phone" -> {
                    if (phone.isEmpty()) break;
                    if (all == null) all = repo.list(tenant, "users");
                    JsonNode hit = active(all, (x) -> !phoneKey(Js.str(x, "phone")).isEmpty() && phoneKey(Js.str(x, "phone")).equals(phone));
                    if (hit != null) return hit;
                }
                case "email" -> {
                    if (email.isEmpty()) break;
                    if (all == null) all = repo.list(tenant, "users");
                    JsonNode hit = active(all, (x) -> !Js.str(x, "email").isEmpty() && Js.str(x, "email").toLowerCase(Locale.ROOT).equals(email));
                    if (hit != null) return hit;
                }
                default -> { }
            }
        }
        return null;
    }

    private static JsonNode active(List<JsonNode> rows, java.util.function.Predicate<JsonNode> match) {
        for (JsonNode r : rows) if (!Js.is(r, "status", "Inactive") && match.test(r)) return r;
        return null;
    }

    /** '+' and digits only: "+91 98765-43210" and "919876543210" are the same phone. */
    static String phoneKey(String raw) {
        String digits = raw == null ? "" : raw.replaceAll("[^0-9]", "");
        return digits.isEmpty() ? "" : "+" + digits;
    }
}
