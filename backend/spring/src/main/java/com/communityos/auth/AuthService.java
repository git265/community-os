package com.communityos.auth;

import com.communityos.finance.SystemWriter;
import com.communityos.port.DocumentRepository;
import com.communityos.port.OutboundChannel;
import com.communityos.security.Js;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Phone sign-in with one-time codes, sessions and tokens: the handlers of backend/contract-server/auth.mjs (local provider) on the Spring server.
 *
 *   POST /api/auth/request-code {phone | invite}   a 6-digit code (5 minutes, 3 tries) for a registered, active number
 *   POST /api/auth/verify {phone, code, roleId?, unit?}   a right code starts a session: access token (15 minutes) + refresh cookie (7 days, HttpOnly)
 *   POST /api/auth/refresh      new access token, rotated cookie; presenting an OLD refresh token revokes the whole session (a stolen cookie is useless)
 *   POST /api/auth/switch-role  a person with several roles changes the one the session acts as
 *   GET  /api/auth/me, /config, /community, /invite/{token}; POST /api/auth/logout; demo roster only with app.auth.demo-roster
 *
 * Limits: codes per phone per hour, per network per hour, 20 s between codes, and a lock-out after repeated wrong codes. Codes and refresh tokens are kept
 * only as hashes. A person's roles come from the community's own `users` and `roles`; the token never decides them.
 */
public class AuthService {
    private static final Logger log = LoggerFactory.getLogger(AuthService.class);
    public static final String COOKIE = "cos_rt";
    private static final SecureRandom RANDOM = new SecureRandom();

    /** What a handler needs from the HTTP request. */
    public record Call(String ip, String cookie) {}
    /** A handler's answer: the JSON body and, when the refresh cookie changes, the Set-Cookie value. */
    public record Out(JsonNode body, String setCookie) {}
    /** Who a valid local token is, after the session and the users row were checked. */
    public record LocalUser(String userId, String roleId, String name, List<String> units, String unit, List<String> blocks, String phone, String email, boolean demo, String sid) {}

    private final AuthProperties cfg;
    private final AuthStore store;
    private final Tokens tokens;
    private final DocumentRepository repo;
    private final AuditTrail audit;
    private final ObjectMapper json;
    private final Clock clock;
    private final OutboundChannel sms;
    private final String communityClaim;
    private final boolean enforced;

    /**
     * @param enforced       true when app.security.mode=local (what /api/auth/config tells the screen)
     * @param communityClaim the claim that lists the communities a token covers (app.security.tenant-claim)
     * @param sms            the SMS channel, for otp-delivery=sms (may be null otherwise)
     */
    public AuthService(AuthProperties cfg, AuthStore store, Tokens tokens, DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, OutboundChannel sms,
                       String communityClaim, boolean enforced) {
        this.cfg = cfg; this.store = store; this.tokens = tokens; this.repo = repo; this.audit = audit; this.json = json; this.clock = clock; this.sms = sms;
        this.communityClaim = communityClaim == null || communityClaim.isBlank() ? "community" : communityClaim; this.enforced = enforced;
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------

    /** '+' and the digits of a number, '' when it has none. */
    public static String phoneKey(String raw) { String d = raw == null ? "" : raw.replaceAll("[^0-9]", ""); return d.isEmpty() ? "" : "+" + d; }
    public static String maskPhone(String e164) { return e164 == null || e164.isEmpty() ? "" : e164.substring(0, Math.min(3, e164.length())) + "••••••" + e164.substring(Math.max(0, e164.length() - 3)); }
    static String sha(String s) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8))); } catch (Exception e) { throw new IllegalStateException(e); }
    }
    private static boolean eq(String a, String b) { return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8)); }
    private static String randomToken() { byte[] b = new byte[32]; RANDOM.nextBytes(b); return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }
    private Instant now() { return clock.instant(); }

    private long accessTtl() { return cfg.accessTokenMinutes() * 60L; }
    private long refreshTtl() { return cfg.refreshTokenDays() * 86400L; }

    public String cookie(String value, long maxAge) {
        return COOKIE + "=" + value + "; HttpOnly; Path=/api/auth; SameSite=" + (cfg.secureCookie() ? "None" : "Lax") + "; Max-Age=" + maxAge + (cfg.secureCookie() ? "; Secure" : "");
    }

    private static List<String> rolesOf(JsonNode u) {
        List<String> out = new ArrayList<>();
        if (Js.truthy(u, "roleId")) out.add(Js.str(u, "roleId"));
        for (JsonNode r : Js.list(u, "extraRoleIds")) if (Js.truthy(r)) out.add(Js.toStr(r));
        return out;
    }

    private List<JsonNode> usersByPhone(String tenant, String phone) {
        String digits = phone.replaceAll("[^0-9]", "");
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode u : repo.list(tenant, "users")) if (!digits.isEmpty() && Js.str(u, "phone").replaceAll("[^0-9]", "").equals(digits)) out.add(u);
        return out;
    }

    private ArrayNode roleInfo(String tenant, List<String> ids) {
        List<JsonNode> all = repo.list(tenant, "roles");
        ArrayNode out = json.createArrayNode();
        for (String id : ids) {
            JsonNode r = null;
            for (JsonNode x : all) if (id.equals(Js.text(x, "id"))) { r = x; break; }
            out.addObject().put("id", id).put("name", r != null && Js.truthy(r, "name") ? Js.str(r, "name") : id).put("category", r != null ? Js.str(r, "category") : "");
        }
        return out;
    }

    private ArrayNode arr(JsonNode v) { ArrayNode a = json.createArrayNode(); if (v != null && v.isArray()) a.addAll((ArrayNode) v); return a; }

    ObjectNode publicUser(JsonNode u, String roleId, String unit) {
        ObjectNode o = json.createObjectNode();
        o.put("id", Js.str(u, "id")).put("name", Js.str(u, "name")).put("roleId", roleId);
        ArrayNode ids = json.createArrayNode(); rolesOf(u).forEach(ids::add); o.set("roleIds", ids);
        ArrayNode units = arr(Js.f(u, "units"));
        o.set("units", units);
        o.put("unit", unit != null ? unit : units.size() > 0 ? Js.toStr(units.get(0)) : "");
        o.set("blocks", arr(Js.f(u, "blocks")));
        o.put("email", Js.str(u, "email")).put("phone", Js.str(u, "phone"));
        return o;
    }

    private String accessToken(String tenant, String userId, String roleId, String sid, boolean demo, JsonNode profile) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("sub", userId); c.put("sid", sid); c.put("role", roleId); c.put("demo", demo); c.put(communityClaim, List.of(tenant));
        if (demo && profile != null) {
            c.put("name", Js.str(profile, "name"));
            c.put("units", json.convertValue(arr(Js.f(profile, "units")), List.class));
            c.put("blocks", json.convertValue(arr(Js.f(profile, "blocks")), List.class));
        }
        return tokens.sign(c, accessTtl());
    }

    private record Started(String accessToken, long expiresIn, String sid, String cookie) {}

    private Started startSession(Call call, String tenant, String userId, String roleId, boolean demo, JsonNode profile) {
        String sid = UUID.randomUUID().toString(), refresh = randomToken();
        store.addSession(new AuthStore.Session(sid, tenant, userId, roleId, sha(refresh), demo, profile, now().plusSeconds(refreshTtl()), null), call.ip());
        return new Started(accessToken(tenant, userId, roleId, sid, demo, profile), accessTtl(), sid, cookie(refresh, refreshTtl()));
    }

    private void auditSignIn(String tenant, String who, String action, String summary, String ip) {
        ObjectNode e = audit.entry(SystemWriter.principal(who), "Sign-in", "", "", "", "", action, summary, null);
        if (ip != null && !ip.isEmpty()) e.put("ip", ip);
        audit.write(tenant, e);
    }

    /** The phone number a request is about: typed in, or (invite link) read from the invite, so the link never has to show it. */
    private String phoneOf(String tenant, JsonNode body) {
        if (Js.truthy(body, "invite")) {
            String token = Js.toStr(Js.f(body, "invite"));
            for (JsonNode i : repo.list(tenant, "portalInvites")) if (token.equals(Js.text(i, "token"))) return phoneKey(Js.str(i, "phone"));
            throw new AuthException(404, "This sign-in link is not valid. Ask the community office for a new one.");
        }
        return phoneKey(Js.str(body, "phone"));
    }

    private String locked() { return "Too many wrong codes. This number is locked for " + cfg.lockMinutes() + " minutes."; }

    // ---- the handlers -------------------------------------------------------------------------------------------------

    /** GET /api/auth/config: what the sign-in screen needs before anyone is signed in. */
    public ObjectNode config() {
        ObjectNode o = json.createObjectNode();
        o.put("mode", enforced ? "enforce" : "open").put("provider", "local").put("demoRoster", cfg.demoRoster()).put("otpEcho", "echo".equals(cfg.otpDelivery()));
        // Spring always runs its own rule book, version check and audit trail, also in the open development modes (none / api-key): the screen must then
        // send the version it loaded and let the server stamp the next one, instead of stamping it itself (which this server refuses as a conflict).
        o.put("authority", "server");
        o.putNull("oidc");
        o.put("accessTokenSeconds", accessTtl());
        return o;
    }

    /** GET /api/auth/community: the little the sign-in screen may show before anyone is signed in. */
    public ObjectNode community(String tenant) {
        JsonNode c = repo.get("platform", "communities", tenant).orElseThrow(() -> new AuthException(404, "No such community."));
        ObjectNode o = json.createObjectNode();
        Js.set(o, "id", Js.f(c, "id")); Js.set(o, "slug", Js.f(c, "slug")); Js.set(o, "name", Js.f(c, "name")); Js.set(o, "status", Js.f(c, "status"));
        o.set("unitTypes", Js.truthy(c, "unitTypes") ? Js.f(c, "unitTypes") : json.getNodeFactory().textNode(""));
        return o;
    }

    /** GET /api/auth/invite/{token}: what the "you were registered" link may reveal (never the full phone number). */
    public ObjectNode invite(String tenant, String token) {
        JsonNode inv = null;
        for (JsonNode i : repo.list(tenant, "portalInvites")) if (token != null && token.equals(Js.text(i, "token"))) { inv = i; break; }
        ObjectNode o = json.createObjectNode();
        if (inv == null) return o.put("state", "unknown");
        String phone = phoneKey(Js.str(inv, "phone"));
        JsonNode u = null;
        for (JsonNode x : repo.list(tenant, "users")) if (Js.truthy(x, "phone") && phoneKey(Js.str(x, "phone")).equals(phone)) { u = x; break; }
        String today = now().toString().substring(0, 10);
        String state = Js.is(inv, "status", "Revoked") || u == null || Js.is(u, "status", "Inactive") ? "revoked" : Js.str(inv, "expiresAt").compareTo(today) < 0 && Js.truthy(inv, "expiresAt") ? "expired" : "ok";
        return o.put("state", state).put("personName", Js.str(inv, "personName")).put("unit", Js.str(inv, "unit")).put("phoneMasked", maskPhone(phone));
    }

    /** GET /api/auth/roster: the demo sign-in tabs (app.auth.demo-roster only). */
    public ObjectNode roster(String tenant) {
        if (!cfg.demoRoster()) throw new AuthException(404, "Not found.");
        ObjectNode o = json.createObjectNode();
        ArrayNode roles = o.putArray("roles"), units = o.putArray("units"), people = o.putArray("people");
        for (JsonNode r : repo.list(tenant, "roles")) roles.addObject().put("id", Js.str(r, "id")).put("name", Js.str(r, "name")).put("category", Js.str(r, "category"));
        for (JsonNode p : repo.list(tenant, "properties")) units.addObject().put("unit", Js.str(p, "unit")).put("owner", Js.str(p, "owner"));
        for (JsonNode u : repo.list(tenant, "users")) {
            if (Js.is(u, "status", "Inactive")) continue;
            ObjectNode x = people.addObject().put("id", Js.str(u, "id")).put("name", Js.str(u, "name")).put("roleId", Js.str(u, "roleId"));
            x.set("extraRoleIds", arr(Js.f(u, "extraRoleIds"))); x.set("units", arr(Js.f(u, "units"))); x.set("blocks", arr(Js.f(u, "blocks")));
        }
        return o;
    }

    /** POST /api/auth/request-code {phone | invite} */
    public ObjectNode requestCode(Call call, String tenant, JsonNode body) {
        String phone = phoneOf(tenant, body);
        if (phone.length() < 8) throw new AuthException(400, "Enter the phone number with its country code, e.g. +91 98450 71234.");
        String ip = call.ip() == null ? "" : call.ip();
        if (store.attempts("code:ip:" + ip, 3600) >= cfg.codesPerIpHour()) throw new AuthException(429, "Too many requests from this network. Try again later.");
        if (store.attempts("fail:phone:" + tenant + ":" + phone, cfg.lockMinutes() * 60L) >= cfg.lockAfterFailures()) throw new AuthException(429, locked(), "locked");
        store.note("code:ip:" + ip);
        List<JsonNode> users = usersByPhone(tenant, phone);
        if (users.isEmpty()) throw new AuthException(404, "This number is not registered in this community. Ask the community office to add it to your property.");
        if (users.stream().allMatch(u -> Js.is(u, "status", "Inactive"))) throw new AuthException(403, "Access for this number has been deactivated. Please contact the community office.");
        Optional<Instant> last = store.lastCodeAt(tenant, phone);
        if (last.isPresent()) {
            double age = Duration.between(last.get(), now()).toMillis() / 1000.0;
            if (age < cfg.resendSeconds()) throw new AuthException(429, "Please wait " + (long) Math.ceil(cfg.resendSeconds() - age) + " seconds before asking for another code.");
        }
        if (store.attempts("code:phone:" + tenant + ":" + phone, 3600) >= cfg.codesPerPhoneHour()) throw new AuthException(429, "Too many codes asked for this number. Try again in an hour.");
        store.note("code:phone:" + tenant + ":" + phone);
        String code = String.valueOf(100000 + RANDOM.nextInt(900000));
        byte[] s = new byte[8]; RANDOM.nextBytes(s);
        String salt = HexFormat.of().formatHex(s);
        store.retireCodes(tenant, phone);
        store.addCode(tenant, phone, salt, sha(salt + ":" + tenant + ":" + phone + ":" + code), now().plusSeconds(cfg.otpMinutes() * 60L));
        switch (cfg.otpDelivery()) {
            case "sms" -> {
                if (sms == null) throw new AuthException(503, "Codes cannot be sent right now. Please try again later.");
                try {
                    sms.send(new com.communityos.domain.OutboundMessage("signin-otp", sms.channel(), phone, Js.str(users.get(0), "name"), "",
                            "Your sign-in code is " + code + ". It works for " + cfg.otpMinutes() + " minutes. Do not share it with anyone."));
                } catch (Exception e) {
                    log.warn("sign-in code for {} could not be sent: {}", maskPhone(phone), e.toString());
                    throw new AuthException(502, "The code could not be sent. Please try again in a minute.");
                }
            }
            case "log" -> log.info("[otp] {} {}: {}", tenant, phone, code);   // development: the code is in the server log
            default -> { }
        }
        ObjectNode o = json.createObjectNode().put("sent", true).put("phone", phone).put("expiresIn", cfg.otpMinutes() * 60L);
        if ("echo".equals(cfg.otpDelivery())) o.put("code", code);
        return o;
    }

    /** POST /api/auth/verify {phone | invite, code, roleId?, unit?} */
    public Out verify(Call call, String tenant, JsonNode body) {
        String phone = phoneOf(tenant, body);
        String code = Js.trim(Js.f(body, "code").isMissingNode() || Js.f(body, "code").isNull() ? "" : Js.toStr(Js.f(body, "code")));
        if (store.attempts("fail:phone:" + tenant + ":" + phone, cfg.lockMinutes() * 60L) >= cfg.lockAfterFailures()) throw new AuthException(429, locked(), "locked");
        AuthStore.Code row = store.latestCode(tenant, phone).orElseThrow(() -> new AuthException(400, "Ask for a code first."));
        if (row.expiresAt().isBefore(now())) { store.useCode(row.id()); throw new AuthException(400, "That code has expired. Ask for a new one."); }
        if (row.tries() >= cfg.otpTries()) { store.useCode(row.id()); throw new AuthException(400, "Too many wrong attempts. Ask for a new code."); }
        OptionalInt bump = store.bumpTries(row.id(), cfg.otpTries());   // atomic: parallel guesses cannot exceed the limit
        if (bump.isEmpty()) throw new AuthException(400, "Too many wrong attempts. Ask for a new code.");
        if (!eq(sha(row.salt() + ":" + tenant + ":" + phone + ":" + code), row.hash())) {
            store.note("fail:phone:" + tenant + ":" + phone);
            int left = cfg.otpTries() - bump.getAsInt();
            auditSignIn(tenant, phone, "Sign-in failed", "Wrong code for " + phone, call.ip());
            throw new AuthException(400, "That code is not right (" + left + " attempt" + (left == 1 ? "" : "s") + " left).");
        }
        store.useCode(row.id());
        JsonNode u = null;
        for (JsonNode x : usersByPhone(tenant, phone)) if (!Js.is(x, "status", "Inactive")) { u = x; break; }
        if (u == null) throw new AuthException(403, "Access for this number is no longer active.");
        String nowIso = now().toString();
        if (Js.is(u, "status", "Invited")) {   // the first sign-in turns an invited person into an active one
            ObjectNode patch = ((ObjectNode) u).deepCopy();
            patch.put("status", "Active").put("activatedAt", nowIso);
            repo.upsert(tenant, "users", Js.str(u, "id"), patch);
            u = patch;
        }
        String digits = phone.replaceAll("[^0-9]", "");
        for (JsonNode inv : repo.list(tenant, "portalInvites")) {
            if (!Js.is(inv, "status", "Sent") || !Js.str(inv, "phone").replaceAll("[^0-9]", "").equals(digits)) continue;
            ObjectNode n = ((ObjectNode) inv).deepCopy(); n.put("status", "Accepted").put("acceptedAt", nowIso);
            repo.upsert(tenant, "portalInvites", Js.str(inv, "id"), n);
        }
        List<String> roleIds = rolesOf(u);
        if (roleIds.isEmpty()) throw new AuthException(403, "Your account has no role yet. Please contact the community office.");
        String asked = Js.truthy(body, "roleId") ? Js.toStr(Js.f(body, "roleId")) : null;
        String roleId = asked != null && roleIds.contains(asked) ? asked : roleIds.get(0);
        String unit = Js.truthy(body, "unit") && Js.strings(u, "units").contains(Js.toStr(Js.f(body, "unit"))) ? Js.toStr(Js.f(body, "unit")) : null;
        Started s = startSession(call, tenant, Js.str(u, "id"), roleId, false, unit == null ? null : json.createObjectNode().put("unit", unit));
        auditSignIn(tenant, Js.str(u, "name"), "Sign-in", Js.str(u, "name") + " signed in as " + roleId, call.ip());
        ObjectNode o = json.createObjectNode().put("accessToken", s.accessToken()).put("expiresIn", s.expiresIn());
        o.set("user", publicUser(u, roleId, unit));
        o.set("roles", roleInfo(tenant, roleIds));
        return new Out(o, s.cookie());
    }

    /** POST /api/auth/demo {roleId, name, units, blocks, unit?, userId?}: only with app.auth.demo-roster (never in production). */
    public Out demo(Call call, String tenant, JsonNode body) {
        if (!cfg.demoRoster()) throw new AuthException(404, "Not found.");
        if (!Js.truthy(body, "roleId")) throw new AuthException(400, "Choose a role.");
        String roleId = Js.toStr(Js.f(body, "roleId"));
        ArrayNode units = json.createArrayNode(), blocks = json.createArrayNode();
        JsonNode u = Js.f(body, "units"), b = Js.f(body, "blocks");
        if (u.isArray()) for (int i = 0; i < Math.min(20, u.size()); i++) units.add(u.get(i)); else if (Js.truthy(u)) units.add(u);
        if (b.isArray()) for (int i = 0; i < Math.min(20, b.size()); i++) blocks.add(b.get(i)); else if (Js.truthy(b)) blocks.add(b);
        String name = Js.truthy(body, "name") ? Js.toStr(Js.f(body, "name")) : roleId;
        if (name.length() > 80) name = name.substring(0, 80);
        ObjectNode profile = json.createObjectNode().put("name", name);
        profile.set("units", units);
        profile.put("unit", Js.truthy(body, "unit") ? Js.toStr(Js.f(body, "unit")) : units.size() > 0 ? Js.toStr(units.get(0)) : "");
        profile.set("blocks", blocks);
        String userId = "demo:" + (Js.truthy(body, "userId") ? Js.toStr(Js.f(body, "userId")) : roleId);
        Started s = startSession(call, tenant, userId, roleId, true, profile);
        auditSignIn(tenant, name, "Sign-in", name + " signed in (demo roster) as " + roleId, call.ip());
        ObjectNode o = json.createObjectNode().put("accessToken", s.accessToken()).put("expiresIn", s.expiresIn());
        ObjectNode user = o.putObject("user").put("id", userId).put("name", name).put("roleId", roleId);
        user.putArray("roleIds").add(roleId); user.set("units", units); user.set("blocks", blocks); user.put("email", "").put("phone", "");
        return new Out(o, s.cookie());
    }

    /** POST /api/auth/refresh: cookie in, new access token and rotated cookie out. An OLD refresh token revokes the session. */
    public Out refresh(Call call, String tenant) {
        String token = call.cookie();
        if (token == null || token.isEmpty()) throw new AuthException(401, "Sign in again.");
        String h = sha(token);
        AuthStore.Session s = store.sessionByRefresh(h).orElseThrow(() -> new AuthException(401, "Sign in again."));
        if (!s.refreshHash().equals(h)) { store.revoke(s.id()); throw new AuthException(401, "Sign in again."); }   // a used token again: someone copied it
        if (s.revokedAt() != null || s.expiresAt().isBefore(now())) throw new AuthException(401, "Sign in again.");
        if (tenant != null && !tenant.isEmpty() && !s.tenant().equals(tenant)) throw new AuthException(401, "Sign in again.");
        JsonNode user = null;
        if (!s.demo()) {
            user = repo.get(s.tenant(), "users", s.userId()).orElse(null);
            if (user == null || Js.is(user, "status", "Inactive")) { store.revoke(s.id()); throw new AuthException(401, "Access has been withdrawn. Please contact the community office."); }
        }
        String next = randomToken();
        store.rotate(s.id(), sha(next));
        String roleId = user != null && !rolesOf(user).contains(s.roleId()) && !rolesOf(user).isEmpty() ? rolesOf(user).get(0) : s.roleId();
        ObjectNode o = json.createObjectNode().put("accessToken", accessToken(s.tenant(), s.userId(), roleId, s.id(), s.demo(), s.profile())).put("expiresIn", accessTtl());
        String unit = s.profile() != null && Js.truthy(s.profile(), "unit") ? Js.str(s.profile(), "unit") : null;
        if (user != null) o.set("user", publicUser(user, roleId, unit));
        else {
            ObjectNode u = o.putObject("user").put("id", s.userId()).put("roleId", roleId);
            u.putArray("roleIds").add(roleId);
            if (s.profile() != null && s.profile().isObject()) u.setAll((ObjectNode) s.profile());
        }
        return new Out(o, cookie(next, refreshTtl()));
    }

    /** POST /api/auth/switch-role {roleId, unit?} (with the access token). */
    public ObjectNode switchRole(Map<String, Object> claims, JsonNode body) {
        AuthStore.Session s = store.session(String.valueOf(claims.get("sid"))).filter(x -> x.revokedAt() == null).orElseThrow(() -> new AuthException(401, "Sign in again."));
        if (s.demo()) throw new AuthException(403, "Demo sessions cannot switch role; sign in again.");
        JsonNode user = repo.get(s.tenant(), "users", s.userId()).orElse(null);
        String roleId = Js.truthy(body, "roleId") ? Js.toStr(Js.f(body, "roleId")) : s.roleId();
        if (user == null || !rolesOf(user).contains(roleId)) throw new AuthException(403, "That role is not assigned to you.");
        String unit = Js.truthy(body, "unit") ? Js.toStr(Js.f(body, "unit")) : null;
        if (unit != null && !Js.strings(user, "units").contains(unit)) throw new AuthException(403, "That unit is not yours.");
        store.switchRole(s.id(), roleId, unit);
        ObjectNode o = json.createObjectNode().put("accessToken", accessToken(s.tenant(), s.userId(), roleId, s.id(), false, null)).put("expiresIn", accessTtl());
        o.set("user", publicUser(user, roleId, unit));
        return o;
    }

    /** GET /api/auth/me: who the token says I am, as the app needs it. */
    public ObjectNode me(String tenant, LocalUser p) {
        if (p.demo()) {
            ObjectNode o = json.createObjectNode().put("id", p.userId()).put("name", p.name()).put("roleId", p.roleId());
            o.putArray("roleIds").add(p.roleId());
            ArrayNode units = o.putArray("units"); p.units().forEach(units::add);
            o.put("unit", p.unit());
            ArrayNode blocks = o.putArray("blocks"); p.blocks().forEach(blocks::add);
            return o.put("email", "").put("phone", "");
        }
        JsonNode u = repo.get(tenant, "users", p.userId()).orElseThrow(() -> new AuthException(401, "Sign in again."));
        return publicUser(u, p.roleId(), p.unit());
    }

    /** POST /api/auth/logout: revokes the session behind the cookie and clears it. */
    public Out logout(Call call) {
        if (call.cookie() != null && !call.cookie().isEmpty()) store.revokeByRefresh(sha(call.cookie()));
        return new Out(null, cookie("", 0));
    }

    // ---- turning a token into a person ---------------------------------------------------------------------------------

    /** The claims contract: does this token allow this community? The claim may be a list, one id, a list in a text, or "*". */
    public boolean allowsCommunity(Map<String, Object> claims, String tenant) {
        Object v = claims.get(communityClaim);
        List<String> list = new ArrayList<>();
        if (v instanceof List<?> l) l.forEach(x -> list.add(String.valueOf(x)));
        else if (v instanceof String s) for (String x : s.split("[\\s,]+")) list.add(x);
        return list.contains("*") || list.contains(tenant);
    }

    public Map<String, Object> claims(String bearer) { return tokens.verify(bearer); }

    /** A valid token's person in this community: the session must still be live and the users row still active. */
    public LocalUser principal(Map<String, Object> claims, String tenant) {
        if (!allowsCommunity(claims, tenant)) throw new AuthException(403, "This sign-in does not cover this community.");
        String sid = claims.get("sid") == null ? "" : String.valueOf(claims.get("sid"));
        AuthStore.Session s = store.session(sid).orElse(null);
        if (s == null || s.revokedAt() != null || s.expiresAt().isBefore(now())) throw new AuthException(401, "Your session has ended. Please sign in again.", "expired");
        String sub = claims.get("sub") == null ? "" : String.valueOf(claims.get("sub"));
        if (Boolean.TRUE.equals(claims.get("demo"))) {
            if (!cfg.demoRoster()) throw new AuthException(401, "Your session has ended. Please sign in again.");
            List<String> units = strings(claims.get("units")), blocks = strings(claims.get("blocks"));
            String unit = s.profile() != null && Js.truthy(s.profile(), "unit") ? Js.str(s.profile(), "unit") : units.isEmpty() ? "" : units.get(0);
            Object name = claims.get("name");
            return new LocalUser(sub, s.roleId(), name == null || String.valueOf(name).isEmpty() ? sub : String.valueOf(name), units, unit, blocks, "", "", true, sid);
        }
        JsonNode u = repo.get(tenant, "users", sub).orElse(null);
        if (u == null || Js.is(u, "status", "Inactive")) throw new AuthException(401, "Access has been withdrawn. Please contact the community office.", "deactivated");
        List<String> roles = rolesOf(u);
        if (roles.isEmpty()) throw new AuthException(403, "Your account has no role yet. Please contact the community office.");
        String roleId = roles.contains(s.roleId()) ? s.roleId() : roles.get(0);
        List<String> units = Js.strings(u, "units");
        String chosen = s.profile() != null ? Js.str(s.profile(), "unit") : "";
        String unit = !chosen.isEmpty() && units.contains(chosen) ? chosen : units.isEmpty() ? "" : units.get(0);
        return new LocalUser(Js.str(u, "id"), roleId, Js.str(u, "name"), units, unit, Js.strings(u, "blocks"), Js.str(u, "phone"), Js.str(u, "email"), false, sid);
    }

    private static List<String> strings(Object v) { List<String> out = new ArrayList<>(); if (v instanceof List<?> l) l.forEach(x -> out.add(String.valueOf(x))); return out; }
}
