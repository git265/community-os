package com.communityos.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.port.DocumentRepository;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Phone sign-in: the same cases as the sign-in tests of backend/contract-server/test/api.test.mjs, on the Java service with the in-memory store. */
class AuthServiceTest {
    static final String SECRET = "test-secret-test-secret-test-secret-0123";
    final ObjectMapper json = new ObjectMapper();
    final MovingClock clock = new MovingClock(Instant.parse("2026-10-20T06:00:00Z"));
    DocumentRepository repo;
    AuthService auth;
    InMemoryAuthStore store;
    final AuthService.Call ip1 = new AuthService.Call("10.0.0.1", "");

    static final class MovingClock extends Clock {
        Instant now;
        MovingClock(Instant now) { this.now = now; }
        void plus(long seconds) { now = now.plusSeconds(seconds); }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    private void user(String id, String name, String phone, String status, String roleId, String... extra) {
        ObjectNode u = json.createObjectNode().put("id", id).put("name", name).put("phone", phone).put("status", status).put("roleId", roleId);
        u.putArray("units").add("A-101");
        var e = u.putArray("extraRoleIds"); for (String r : extra) e.add(r);
        repo.upsert("t", "users", id, u);
    }

    private AuthService service(AuthProperties p) {
        store = new InMemoryAuthStore(clock);
        return new AuthService(p, store, new Tokens(SECRET, p.issuer(), clock, json), repo, new AuditTrail(repo, json, clock), json, clock, null, "community", true);
    }

    @BeforeEach
    void setUp() {
        repo = new InMemoryDocumentRepository();
        user("u-guard", "Guard Gopal", "+91 98000 00011", "Active", "security");
        user("u-treas", "Tara", "+91 98000 00021", "Active", "treasurer");
        user("u-gone", "Old Owner", "+91 98000 00031", "Inactive", "owner");
        user("u-multi", "Mira", "+91 98000 00041", "Invited", "owner", "committee_amenities");
        repo.upsert("t", "roles", "treasurer", json.createObjectNode().put("id", "treasurer").put("name", "Treasurer").put("category", "EC"));
        repo.upsert("t", "portalInvites", "i1", json.createObjectNode().put("id", "i1").put("token", "tok-1").put("phone", "919800000041").put("status", "Sent").put("expiresAt", "2026-12-31").put("personName", "Mira").put("unit", "A-101"));
        auth = service(AuthProperties.defaults(SECRET));
    }

    private JsonNode body(String... kv) { ObjectNode o = json.createObjectNode(); for (int i = 0; i < kv.length; i += 2) o.put(kv[i], kv[i + 1]); return o; }
    private int status(Runnable r) { try { r.run(); return 200; } catch (AuthException e) { return e.status(); } }

    private AuthService.Out signIn(String phone) {
        String code = auth.requestCode(ip1, "t", body("phone", phone)).get("code").asText();
        return auth.verify(ip1, "t", body("phone", phone, "code", code));
    }
    private static String cookieValue(String setCookie) { return setCookie.substring(setCookie.indexOf('=') + 1, setCookie.indexOf(';')); }

    @Test
    void unregisteredAndDeactivatedNumbersAreToldToContactTheOffice() {
        assertEquals(404, status(() -> auth.requestCode(ip1, "t", body("phone", "+91 98000 55555"))));
        AuthException e = assertThrows(AuthException.class, () -> auth.requestCode(ip1, "t", body("phone", "+91 98000 00031")));
        assertEquals(403, e.status());
        assertTrue(e.getMessage().contains("deactivated"));
        assertEquals(400, status(() -> auth.requestCode(ip1, "t", body("phone", "12345"))), "too short to be a number with its country code");
    }

    @Test
    void aRightCodeSignsInAndTheTokenNamesAliveSession() {
        AuthService.Out out = signIn("+91 98000 00021");
        assertEquals("Tara", out.body().path("user").path("name").asText());
        assertEquals("treasurer", out.body().path("user").path("roleId").asText());
        assertTrue(out.setCookie().startsWith("cos_rt=") && out.setCookie().contains("HttpOnly") && out.setCookie().contains("Path=/api/auth"));
        Map<String, Object> claims = auth.claims(out.body().get("accessToken").asText());
        AuthService.LocalUser p = auth.principal(claims, "t");
        assertEquals("u-treas", p.userId());
        assertEquals("treasurer", p.roleId());
        assertEquals(403, status(() -> auth.principal(claims, "other-community")), "a token covers only its own community");
        assertTrue(repo.list("t", "audit").stream().anyMatch(a -> a.path("action").asText().equals("Sign-in") && a.path("summary").asText().equals("Tara signed in as treasurer")));
    }

    @Test
    void aWrongCodeIsRefusedAndThreeWrongCodesBurnIt() {
        String code = auth.requestCode(ip1, "t", body("phone", "+91 98000 00011")).get("code").asText();
        String wrong = code.equals("111111") ? "222222" : "111111";
        AuthException first = assertThrows(AuthException.class, () -> auth.verify(ip1, "t", body("phone", "+91 98000 00011", "code", wrong)));
        assertEquals("That code is not right (2 attempts left).", first.getMessage());
        for (int i = 0; i < 2; i++) assertEquals(400, status(() -> auth.verify(ip1, "t", body("phone", "+91 98000 00011", "code", wrong))));
        assertEquals(400, status(() -> auth.verify(ip1, "t", body("phone", "+91 98000 00011", "code", code))), "the code no longer works after 3 wrong tries");
        assertEquals(3, repo.list("t", "audit").stream().filter(a -> a.path("action").asText().equals("Sign-in failed")).count());
    }

    @Test
    void fiveWrongCodesLockTheNumber() {
        AuthService a = service(new AuthProperties("echo", 15, 7, 5, 3, 0, 50, 50, 5, 15, "communityos", SECRET, false, false, false));
        for (int i = 0; i < 5; i++) {
            a.requestCode(ip1, "t", body("phone", "+91 98000 00041"));
            try { a.verify(ip1, "t", body("phone", "+91 98000 00041", "code", "000000")); } catch (AuthException e) { /* wrong on purpose */ }
        }
        AuthException e = assertThrows(AuthException.class, () -> a.requestCode(ip1, "t", body("phone", "+91 98000 00041")));
        assertEquals(429, e.status());
        assertEquals("locked", e.code());
        clock.plus(16 * 60);
        assertEquals(200, status(() -> a.requestCode(ip1, "t", body("phone", "+91 98000 00041"))), "the lock ends after lock-minutes");
    }

    @Test
    void askingForCodesIsRateLimitedPerNumberAndPerNetworkAndAResendNeedsAGap() {
        AuthService l = service(new AuthProperties("echo", 15, 7, 5, 3, 0, 2, 4, 5, 15, "communityos", SECRET, false, false, false));
        int[] codes = new int[3];
        for (int i = 0; i < 3; i++) codes[i] = status(() -> l.requestCode(ip1, "t", body("phone", "+91 98000 00021")));
        assertEquals("[200, 200, 429]", java.util.Arrays.toString(codes), "third code for one number in an hour");
        boolean limited = false;
        for (String ph : new String[] {"+91 98000 00011", "+91 98000 00041", "+91 98000 00011"}) limited |= status(() -> l.requestCode(ip1, "t", body("phone", ph))) == 429;
        assertTrue(limited, "the network limit stops a spray of numbers");
        AuthService g = service(new AuthProperties("echo", 15, 7, 5, 3, 30, 5, 30, 5, 15, "communityos", SECRET, false, false, false));
        assertEquals(200, status(() -> g.requestCode(ip1, "t", body("phone", "+91 98000 00011"))));
        AuthException e = assertThrows(AuthException.class, () -> g.requestCode(ip1, "t", body("phone", "+91 98000 00011")));
        assertEquals(429, e.status());
        assertEquals("Please wait 30 seconds before asking for another code.", e.getMessage());
    }

    @Test
    void anExpiredCodeIsRefused() {
        String code = auth.requestCode(ip1, "t", body("phone", "+91 98000 00021")).get("code").asText();
        clock.plus(5 * 60 + 1);
        AuthException e = assertThrows(AuthException.class, () -> auth.verify(ip1, "t", body("phone", "+91 98000 00021", "code", code)));
        assertEquals("That code has expired. Ask for a new one.", e.getMessage());
    }

    @Test
    void refreshRotatesTheCookieAndTheOldCookieIsTheftAndEndsTheSession() {
        AuthService.Out a = signIn("+91 98000 00021");
        AuthService.Out r1 = auth.refresh(new AuthService.Call("10.0.0.1", cookieValue(a.setCookie())), "t");
        assertNotNull(r1.body().get("accessToken"));
        assertNotEquals(cookieValue(a.setCookie()), cookieValue(r1.setCookie()));
        AuthService.Out r2 = auth.refresh(new AuthService.Call("10.0.0.1", cookieValue(r1.setCookie())), "t");
        assertEquals(401, status(() -> auth.refresh(new AuthService.Call("10.0.0.1", cookieValue(a.setCookie())), "t")), "reusing the first cookie");
        assertEquals(401, status(() -> auth.refresh(new AuthService.Call("10.0.0.1", cookieValue(r2.setCookie())), "t")), "the whole session was revoked");
        Map<String, Object> claims = auth.claims(r1.body().get("accessToken").asText());
        assertEquals(401, status(() -> auth.principal(claims, "t")), "and its access tokens stop working at once");
    }

    @Test
    void logoutEndsTheSessionAtOnceEvenForATokenThatHasNotExpired() {
        AuthService.Out a = signIn("+91 98000 00021");
        Map<String, Object> claims = auth.claims(a.body().get("accessToken").asText());
        assertEquals("u-treas", auth.principal(claims, "t").userId());
        AuthService.Out out = auth.logout(new AuthService.Call("10.0.0.1", cookieValue(a.setCookie())));
        assertTrue(out.setCookie().contains("Max-Age=0"));
        AuthException e = assertThrows(AuthException.class, () -> auth.principal(claims, "t"));
        assertEquals(401, e.status());
        assertEquals("expired", e.code());
    }

    @Test
    void deactivatingAUserEndsTheirSessionImmediately() {
        AuthService.Out a = signIn("+91 98000 00041");
        Map<String, Object> claims = auth.claims(a.body().get("accessToken").asText());
        assertEquals("u-multi", auth.principal(claims, "t").userId());
        assertEquals("Active", repo.get("t", "users", "u-multi").get().path("status").asText(), "the first sign-in activates an invited person");
        assertEquals("Accepted", repo.get("t", "portalInvites", "i1").get().path("status").asText(), "and accepts the invite");
        repo.upsert("t", "users", "u-multi", ((ObjectNode) repo.get("t", "users", "u-multi").get()).deepCopy().put("status", "Inactive"));
        AuthException e = assertThrows(AuthException.class, () -> auth.principal(claims, "t"));
        assertEquals("deactivated", e.code());
    }

    @Test
    void thePersonPicksOneOfTheirOwnRolesAndAnyOtherIsRefused() {
        AuthService.Out a = signIn("+91 98000 00041");
        Map<String, Object> claims = auth.claims(a.body().get("accessToken").asText());
        JsonNode sw = auth.switchRole(claims, body("roleId", "committee_amenities"));
        assertEquals("committee_amenities", sw.path("user").path("roleId").asText());
        assertEquals("committee_amenities", auth.principal(auth.claims(sw.get("accessToken").asText()), "t").roleId());
        assertEquals(403, status(() -> auth.switchRole(claims, body("roleId", "super_admin"))));
        assertEquals(403, status(() -> auth.switchRole(claims, body("unit", "Z-999"))), "nor a unit that is not theirs");
    }

    @Test
    void anInviteLinkSignsInWithoutShowingTheNumber() {
        JsonNode inv = auth.invite("t", "tok-1");
        assertEquals("ok", inv.path("state").asText());
        assertEquals("+91••••••041", inv.path("phoneMasked").asText());
        assertEquals("unknown", auth.invite("t", "nope").path("state").asText());
        String code = auth.requestCode(ip1, "t", body("invite", "tok-1")).get("code").asText();
        assertEquals("Mira", auth.verify(ip1, "t", body("invite", "tok-1", "code", code)).body().path("user").path("name").asText());
        assertEquals(404, status(() -> auth.requestCode(ip1, "t", body("invite", "forged"))));
    }

    @Test
    void theDemoRosterIsOffUnlessTheServerIsToldOtherwise() {
        assertEquals(404, status(() -> auth.demo(ip1, "t", body("roleId", "super_admin", "name", "x"))));
        assertFalse(auth.config().path("demoRoster").asBoolean());
        AuthService d = service(new AuthProperties("echo", 15, 7, 5, 3, 20, 5, 30, 5, 15, "communityos", SECRET, true, false, false));
        assertTrue(d.config().path("demoRoster").asBoolean());
        AuthService.Out out = d.demo(ip1, "t", body("roleId", "super_admin", "name", "Demo Dev"));
        AuthService.LocalUser p = d.principal(d.claims(out.body().get("accessToken").asText()), "t");
        assertTrue(p.demo());
        assertEquals("Demo Dev", p.name());
        assertEquals(401, status(() -> auth.principal(d.claims(out.body().get("accessToken").asText()), "t")), "a demo token means nothing to a server without the roster");
    }

    @Test
    void tokensAreCheckedBeforeAnythingInThemIsBelieved() {
        AuthService.Out a = signIn("+91 98000 00021");
        String token = a.body().get("accessToken").asText();
        String[] p = token.split("\\.");
        String forged = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("{\"alg\":\"none\",\"typ\":\"JWT\"}".getBytes()) + "." + p[1] + ".";
        assertEquals(401, status(() -> auth.claims(forged)), "alg none");
        assertEquals(401, status(() -> auth.claims(p[0] + "." + p[1] + "." + p[2].substring(1) + "A")), "a changed signature");
        assertEquals(401, status(() -> new Tokens(SECRET.replace('t', 'x'), "communityos", clock, json).verify(token)), "another server's key");
        clock.plus(16 * 60);
        AuthException e = assertThrows(AuthException.class, () -> auth.claims(token));
        assertEquals("expired", e.code(), "an access token lives 15 minutes");
    }
}
