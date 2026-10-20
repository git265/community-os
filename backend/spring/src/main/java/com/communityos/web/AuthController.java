package com.communityos.web;

import com.communityos.auth.AuthException;
import com.communityos.auth.AuthProperties;
import com.communityos.auth.AuthService;
import com.communityos.auth.LocalAuthentication;
import com.communityos.config.AppProperties;
import com.communityos.service.TenantGuard;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * Phone sign-in (app.security.mode=local): the endpoints of backend/contract-server/auth.mjs, same paths and answers, so the screen works with either server.
 * Open to everyone (they are how one signs in) except /me and /switch-role, which need the access token. The refresh token travels only in an HttpOnly cookie
 * (cos_rt, path /api/auth).
 */
@Tag(name = "Sign-in")
@RestController
public class AuthController {
    private final AuthService auth;
    private final AuthProperties cfg;
    private final TenantGuard guard;
    private final AppProperties props;
    private final ObjectMapper json;

    public AuthController(AuthService auth, AuthProperties cfg, TenantGuard guard, AppProperties props, ObjectMapper json) {
        this.auth = auth; this.cfg = cfg; this.guard = guard; this.props = props; this.json = json;
    }

    private AuthService.Call call(HttpServletRequest req) {
        String ip = req.getRemoteAddr();
        if (cfg.trustProxy()) {   // X-Forwarded-For is believed only behind a proxy you run
            String f = req.getHeader("X-Forwarded-For");
            if (f != null && !f.isBlank()) ip = f.split(",")[0].trim();
        }
        String cookie = "";
        if (req.getCookies() != null) for (jakarta.servlet.http.Cookie c : req.getCookies()) if (AuthService.COOKIE.equals(c.getName())) cookie = c.getValue();
        return new AuthService.Call(ip, cookie);
    }

    private void localOnly() { if (!"local".equals(props.security().mode())) throw new AuthException(404, "Codes are sent by your identity provider."); }

    private JsonNode send(AuthService.Out out, HttpServletResponse res) {
        if (out.setCookie() != null) res.addHeader("Set-Cookie", out.setCookie());
        return out.body();
    }

    private static String tenantOf(String header) { return Names.tenant(header); }

    @Operation(summary = "What the sign-in screen needs", description = "Whether sign-in is enforced, by which provider, whether the demo roster is on.")
    @GetMapping("/api/auth/config")
    public JsonNode config() { return auth.config(); }

    @Operation(summary = "The community's name and status, before sign-in")
    @GetMapping("/api/auth/community")
    public JsonNode community(@RequestHeader("X-Community-Id") String c) { return auth.community(tenantOf(c)); }

    @Operation(summary = "What a 'you were registered' link may show", description = "Never the full phone number.")
    @GetMapping("/api/auth/invite/{token}")
    public JsonNode invite(@RequestHeader("X-Community-Id") String c, @PathVariable String token) { return auth.invite(tenantOf(c), token); }

    @Operation(summary = "Demo roster", description = "Only with app.auth.demo-roster=true (never in production).")
    @GetMapping("/api/auth/roster")
    public JsonNode roster(@RequestHeader("X-Community-Id") String c) { return auth.roster(tenantOf(c)); }

    @Operation(summary = "Send me a sign-in code", description = "{phone} or {invite}. A 6-digit code for a registered, active number: 5 minutes, 3 tries, one every 20 seconds, limits per number and per network.")
    @PostMapping("/api/auth/request-code")
    public JsonNode requestCode(@RequestHeader("X-Community-Id") String c, @RequestBody JsonNode body, HttpServletRequest req) {
        localOnly();
        return auth.requestCode(call(req), tenantOf(c), body);
    }

    @Operation(summary = "Sign in with the code", description = "{phone | invite, code, roleId?, unit?}: access token in the answer, refresh token in an HttpOnly cookie.")
    @PostMapping("/api/auth/verify")
    public JsonNode verify(@RequestHeader("X-Community-Id") String c, @RequestBody JsonNode body, HttpServletRequest req, HttpServletResponse res) {
        localOnly();
        return send(auth.verify(call(req), tenantOf(c), body), res);
    }

    @Operation(summary = "Demo sign-in", description = "Only with app.auth.demo-roster=true.")
    @PostMapping("/api/auth/demo")
    public JsonNode demo(@RequestHeader("X-Community-Id") String c, @RequestBody JsonNode body, HttpServletRequest req, HttpServletResponse res) {
        return send(auth.demo(call(req), tenantOf(c), body), res);
    }

    @Operation(summary = "A new access token", description = "Uses and rotates the refresh cookie. A refresh token used a second time ends the whole session.")
    @PostMapping("/api/auth/refresh")
    public JsonNode refresh(@RequestHeader(value = "X-Community-Id", required = false) String c, HttpServletRequest req, HttpServletResponse res) {
        return send(auth.refresh(call(req), c == null || c.isBlank() ? null : tenantOf(c)), res);
    }

    @Operation(summary = "Act in another of my roles", description = "{roleId, unit?}. Needs the access token.")
    @PostMapping("/api/auth/switch-role")
    public JsonNode switchRole(@RequestHeader("X-Community-Id") String c, @RequestBody JsonNode body, Authentication who) {
        if (!(who instanceof LocalAuthentication la)) throw new AuthException(401, "Sign in to continue.", "unauthenticated");
        guard.resolve(c, who);
        return auth.switchRole(la.claims(), body == null ? json.createObjectNode() : body);
    }

    @Operation(summary = "Who am I", description = "Needs the access token.")
    @GetMapping("/api/auth/me")
    public JsonNode me(@RequestHeader("X-Community-Id") String c, Authentication who) {
        if (!(who instanceof LocalAuthentication la)) throw new AuthException(401, "Sign in to continue.", "unauthenticated");
        String tenant = guard.resolve(c, who);
        return auth.me(tenant, auth.principal(la.claims(), tenant));
    }

    @Operation(summary = "Sign out", description = "Ends the session behind the refresh cookie and clears the cookie.")
    @PostMapping("/api/auth/logout")
    public ResponseEntity<Void> logout(HttpServletRequest req, HttpServletResponse res) {
        send(auth.logout(call(req)), res);
        return ResponseEntity.noContent().build();
    }
}
