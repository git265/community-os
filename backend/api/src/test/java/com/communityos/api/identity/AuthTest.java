package com.communityos.api.identity;

import static org.junit.jupiter.api.Assertions.*;
import static com.communityos.api.TestAsserts.assertNotEquals;

import com.communityos.api.Fixtures;
import com.communityos.api.identity.adapter.JwtTokenIssuer;
import com.communityos.api.identity.application.AuthService;
import com.communityos.api.identity.application.CodeHasher;
import com.communityos.api.identity.application.port.OtpStore;
import com.communityos.api.identity.application.port.PersonDirectory;
import com.communityos.api.identity.application.port.RefreshTokenStore;
import com.communityos.api.identity.domain.OtpChallenge;
import com.communityos.api.identity.domain.Phone;
import com.communityos.api.identity.domain.RefreshToken;
import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.security.CallerJwtConverter;
import com.communityos.api.shared.security.CallerJwtDecoder;
import com.communityos.api.shared.security.JwtCodec;
import com.communityos.api.shared.security.TooManyAttempts;
import com.communityos.api.shared.security.Unauthenticated;
import com.communityos.api.shared.tx.Tx;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class AuthTest {
    static KeyPair ec() throws Exception { KeyPairGenerator g = KeyPairGenerator.getInstance("EC"); g.initialize(new ECGenParameterSpec("secp256r1")); return g.generateKeyPair(); }

    // ---- in-memory ports -------------------------------------------------------------------------------------------------------------------
    static final class Otps implements OtpStore {
        final Map<UUID, OtpChallenge> rows = new HashMap<>();
        public void save(OtpChallenge c, String ip) { rows.put(c.id(), c); }
        public Optional<OtpChallenge> findForUpdate(UUID id) { return Optional.ofNullable(rows.get(id)); }
        public void recordAttempt(UUID id) { OtpChallenge c = rows.get(id); rows.put(id, new OtpChallenge(c.id(), c.phone(), c.codeHash(), c.attempts() + 1, c.maxAttempts(), c.expiresAt(), c.consumedAt())); }
        public boolean consume(UUID id, Instant at) { OtpChallenge c = rows.get(id); if (c.consumedAt() != null) return false; rows.put(id, new OtpChallenge(c.id(), c.phone(), c.codeHash(), c.attempts(), c.maxAttempts(), c.expiresAt(), at)); return true; }
        public int purgeExpired(Instant before) { return 0; }
    }
    static final class Refreshes implements RefreshTokenStore {
        final Map<UUID, RefreshToken> rows = new LinkedHashMap<>();
        public void save(RefreshToken t, String ua, String ip) { rows.put(t.id(), t); }
        public Optional<RefreshToken> findByHashForUpdate(byte[] h) { return rows.values().stream().filter((t) -> java.util.Arrays.equals(t.tokenHash(), h)).findFirst(); }
        public void markUsed(UUID id, Instant at) { RefreshToken t = rows.get(id); rows.put(id, new RefreshToken(t.id(), t.familyId(), t.person(), t.community(), t.membership(), t.tokenHash(), t.expiresAt(), at, t.revokedAt())); }
        public int revokeFamily(UUID f, String reason, Instant at) { int n = 0; for (RefreshToken t : List.copyOf(rows.values())) if (t.familyId().equals(f) && t.revokedAt() == null) { rows.put(t.id(), new RefreshToken(t.id(), t.familyId(), t.person(), t.community(), t.membership(), t.tokenHash(), t.expiresAt(), t.usedAt(), at)); n++; } return n; }
        public int revokeAllOfMembership(UUID m, String r, Instant at) { return 0; }
    }
    static final class People implements PersonDirectory {
        final PersonId person = new PersonId(UUID.randomUUID());
        final List<MembershipRef> memberships = new ArrayList<>();
        boolean active = true;
        public Optional<PersonRef> findActiveByPhone(Phone p) { return p.e164().equals("+919800000001") ? Optional.of(new PersonRef(person, "Asha")) : Optional.empty(); }
        public List<MembershipRef> activeMemberships(PersonId p) { return active ? memberships : List.of(); }
        public boolean isActive(PersonId p, CommunityId c, MembershipId m) { return active; }
        public PersonId findOrCreate(Phone p, String n) { return person; }
    }

    final Otps otps = new Otps(); final Refreshes refreshes = new Refreshes(); final People people = new People();
    final List<String> sent = new ArrayList<>(); final Map<String, Integer> hits = new HashMap<>();
    JwtCodec codec; AuthService auth; KeyPair keys;

    AuthTest() throws Exception {
        KeyPair kp = ec(); keys = kp;
        codec = new JwtCodec(new JwtCodec.Keys("k1", kp.getPrivate(), Map.of("k1", kp.getPublic())), "https://api.test", "app", Clock.systemUTC());
        people.memberships.add(new PersonDirectory.MembershipRef(Fixtures.COMMUNITY, "Palm Meadows", new MembershipId(UUID.randomUUID()), "Asha"));
        auth = new AuthService(otps, refreshes, people, (to, code) -> sent.add(code),
            (key, max, window) -> { int n = hits.merge(key, 1, Integer::sum); if (n > max) throw new TooManyAttempts(window.toSeconds()); },
            new JwtTokenIssuer(codec, Duration.ofMinutes(10), Clock.systemUTC()), new CodeHasher("pepper-pepper-pepper-pepper-pepper-42"), Tx.direct(), Clock.systemUTC(),
            AuthService.Settings.defaults());
    }
    static final AuthService.Client CLIENT = new AuthService.Client("test", "10.0.0.1");

    @Test void signInWithCodeIssuesVerifiableTokens() {
        AuthService.CodeRequested r = auth.requestCode("98000 00001", CLIENT);
        assertEquals(1, sent.size());
        AuthService.SignedIn s = (AuthService.SignedIn) auth.verify(r.challengeId(), sent.get(0), null, CLIENT);
        Map<String, Object> claims = codec.verify(s.tokens().accessToken());
        assertEquals(people.person.toString(), claims.get("sub"));
        assertEquals(Fixtures.COMMUNITY.toString(), claims.get("cid"));
        assertFalse(claims.containsKey("roles"), "no roles in the token: they are read per request");
        assertThrows(Unauthenticated.class, () -> auth.verify(r.challengeId(), sent.get(0), null, CLIENT), "a code works once");
    }

    @Test void unknownNumberGetsTheSameAnswerAndNoMessage() {
        AuthService.CodeRequested r = auth.requestCode("+919811111111", CLIENT);
        assertNotNull(r.challengeId()); assertEquals(300, r.expiresInSeconds());
        assertTrue(sent.isEmpty());
        for (String guess : List.of("000000", "123456")) assertThrows(Unauthenticated.class, () -> auth.verify(r.challengeId(), guess, null, CLIENT));
    }

    @Test void wrongGuessesAreCountedAndLockTheCode() {
        AuthService.CodeRequested r = auth.requestCode("+919800000001", CLIENT);
        String right = sent.get(0), wrong = right.equals("000000") ? "111111" : "000000";
        for (int i = 0; i < 5; i++) assertThrows(Unauthenticated.class, () -> auth.verify(r.challengeId(), wrong, null, CLIENT));
        assertEquals(5, otps.rows.get(r.challengeId()).attempts(), "every guess counted (committed even though the call failed)");
        assertThrows(Unauthenticated.class, () -> auth.verify(r.challengeId(), right, null, CLIENT), "locked after 5 tries, even with the right code");
        assertThrows(Unauthenticated.class, () -> auth.verify(r.challengeId(), "12ab56", null, CLIENT), "not 6 digits");
    }

    @Test void requestsAreRateLimitedPerPhone() {
        for (int i = 0; i < 5; i++) auth.requestCode("+919800000001", CLIENT);
        assertThrows(TooManyAttempts.class, () -> auth.requestCode("+919800000001", CLIENT));
    }

    @Test void severalCommunitiesAskWhichOne() {
        CommunityId other = new CommunityId(UUID.randomUUID());
        people.memberships.add(new PersonDirectory.MembershipRef(other, "Lake View", new MembershipId(UUID.randomUUID()), "Asha"));
        AuthService.CodeRequested r = auth.requestCode("+919800000001", CLIENT);
        AuthService.VerifyResult first = auth.verify(r.challengeId(), sent.get(0), null, CLIENT);
        assertEquals(2, ((AuthService.ChooseCommunity) first).memberships().size());
        AuthService.SignedIn s = (AuthService.SignedIn) auth.verify(r.challengeId(), sent.get(0), other, CLIENT);
        assertEquals(other.toString(), codec.verify(s.tokens().accessToken()).get("cid"));
        AuthService.CodeRequested r2 = auth.requestCode("+919800000001", CLIENT);
        assertThrows(Unauthenticated.class, () -> auth.verify(r2.challengeId(), sent.get(1), new CommunityId(UUID.randomUUID()), CLIENT), "not a member there");
    }

    @Test void refreshRotatesAndReuseRevokesTheFamily() {
        AuthService.CodeRequested r = auth.requestCode("+919800000001", CLIENT);
        AuthService.Tokens t1 = ((AuthService.SignedIn) auth.verify(r.challengeId(), sent.get(0), null, CLIENT)).tokens();
        AuthService.Tokens t2 = auth.refresh(t1.refreshToken(), CLIENT);
        assertNotEquals(t1.refreshToken(), t2.refreshToken());
        assertThrows(Unauthenticated.class, () -> auth.refresh(t1.refreshToken(), CLIENT), "the spent token is refused ...");
        assertThrows(Unauthenticated.class, () -> auth.refresh(t2.refreshToken(), CLIENT), "... and its re-use signs the whole family out");
        assertTrue(refreshes.rows.values().stream().allMatch((t) -> t.revokedAt() != null));
    }

    @Test void deactivatedMemberCannotRefresh() {
        AuthService.CodeRequested r = auth.requestCode("+919800000001", CLIENT);
        AuthService.Tokens t1 = ((AuthService.SignedIn) auth.verify(r.challengeId(), sent.get(0), null, CLIENT)).tokens();
        people.active = false;
        assertThrows(Unauthenticated.class, () -> auth.refresh(t1.refreshToken(), CLIENT));
        assertTrue(refreshes.rows.values().stream().allMatch((t) -> t.revokedAt() != null), "revocation committed");
    }

    @Test void logoutRevokes() {
        AuthService.CodeRequested r = auth.requestCode("+919800000001", CLIENT);
        AuthService.Tokens t1 = ((AuthService.SignedIn) auth.verify(r.challengeId(), sent.get(0), null, CLIENT)).tokens();
        auth.logout(t1.refreshToken());
        assertThrows(Unauthenticated.class, () -> auth.refresh(t1.refreshToken(), CLIENT));
    }

    // ---- token codec ------------------------------------------------------------------------------------------------------------------------
    String token(Map<String, Object> extra) {
        long now = Instant.now().getEpochSecond();
        Map<String, Object> c = new LinkedHashMap<>(Map.of("sub", UUID.randomUUID().toString(), "iat", now, "exp", now + 600, "jti", "j"));
        c.putAll(extra);
        return codec.sign(c);
    }

    @Test void tamperedOrForeignTokensAreRefused() throws Exception {
        String t = token(Map.of());
        assertNotNull(codec.verify(t));
        String[] p = t.split("\\.");
        String forgedBody = Base64.getUrlEncoder().withoutPadding().encodeToString(("{\"sub\":\"x\",\"iss\":\"https://api.test\",\"aud\":\"app\",\"iat\":1,\"exp\":99999999999,\"jti\":\"j\"}").getBytes());
        assertThrows(JwtCodec.InvalidToken.class, () -> codec.verify(p[0] + "." + forgedBody + "." + p[2]), "payload changed");
        String none = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"alg\":\"none\",\"kid\":\"k1\"}".getBytes());
        assertThrows(JwtCodec.InvalidToken.class, () -> codec.verify(none + "." + p[1] + "."), "alg none");
        String hs = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"alg\":\"HS256\",\"kid\":\"k1\"}".getBytes());
        String hsSig = Base64.getUrlEncoder().withoutPadding().encodeToString(Crypto.hmacSha256(new byte[32], (hs + "." + p[1]).getBytes()));
        assertThrows(JwtCodec.InvalidToken.class, () -> codec.verify(hs + "." + p[1] + "." + hsSig), "HS256 key confusion");
        long old = Instant.now().getEpochSecond() - 3600;
        assertThrows(JwtCodec.InvalidToken.class, () -> codec.verify(token(Map.of("iat", old, "exp", old + 600))), "expired");
        KeyPair other = ec();
        JwtCodec foreign = new JwtCodec(new JwtCodec.Keys("k1", other.getPrivate(), Map.of("k1", other.getPublic())), "https://api.test", "app", Clock.systemUTC());
        long now = Instant.now().getEpochSecond();
        assertThrows(JwtCodec.InvalidToken.class, () -> codec.verify(foreign.sign(new LinkedHashMap<>(Map.of("sub", "s", "iat", now, "exp", now + 60, "jti", "j")))), "other key");
        JwtCodec admin = new JwtCodec(new JwtCodec.Keys("k1", keys.getPrivate(), Map.of("k1", keys.getPublic())), "https://api.test", "admin-console", Clock.systemUTC());
        assertThrows(JwtCodec.InvalidToken.class, () -> admin.verify(t), "a token for the app is not accepted by another audience");
    }

    @Test void rotatedKeyIsStillAcceptedAndDecoderConverterBuildTheCaller() throws Exception {
        KeyPair old = ec(), current = ec();
        JwtCodec oldCodec = new JwtCodec(new JwtCodec.Keys("k0", old.getPrivate(), Map.of("k0", old.getPublic())), "i", "a", Clock.systemUTC());
        JwtCodec rotated = new JwtCodec(new JwtCodec.Keys("k1", current.getPrivate(), Map.of("k0", old.getPublic(), "k1", current.getPublic())), "i", "a", Clock.systemUTC());
        long now = Instant.now().getEpochSecond();
        UUID person = UUID.randomUUID(), member = UUID.randomUUID();
        String t = oldCodec.sign(new LinkedHashMap<>(Map.of("sub", person.toString(), "cid", Fixtures.COMMUNITY.toString(), "mid", member.toString(), "iat", now, "exp", now + 60, "jti", "j")));
        org.springframework.security.oauth2.jwt.Jwt jwt = new CallerJwtDecoder(rotated).decode(t);
        assertEquals(person.toString(), jwt.getSubject());
        var caller = Fixtures.owner(Fixtures.UNIT_A);
        CallerJwtConverter conv = new CallerJwtConverter(new com.communityos.api.shared.security.CallerLoader() {
            public Optional<com.communityos.api.shared.security.Caller> load(PersonId p, CommunityId c, MembershipId m) { return m.value().equals(member) ? Optional.of(caller) : Optional.empty(); }
            public void evict(MembershipId m) {}
        });
        assertEquals(caller, conv.convert(jwt).getPrincipal());
        org.springframework.security.oauth2.jwt.Jwt stranger = new CallerJwtDecoder(rotated).decode(oldCodec.sign(new LinkedHashMap<>(Map.of("sub", person.toString(),
            "cid", Fixtures.COMMUNITY.toString(), "mid", UUID.randomUUID().toString(), "iat", now, "exp", now + 60, "jti", "j"))));
        assertThrows(org.springframework.security.authentication.BadCredentialsException.class, () -> conv.convert(stranger), "membership not active -> 401");
        assertThrows(org.springframework.security.oauth2.jwt.BadJwtException.class, () -> new CallerJwtDecoder(rotated).decode(t + "x"));
    }

    @Test void derivedPublicKeyMatchesThePrivateKey() throws Exception {
        KeyPair kp = ec();
        java.lang.reflect.Method m = Class.forName("com.communityos.api.config.SigningKeys").getDeclaredMethod("publicOf", java.security.interfaces.ECPrivateKey.class);
        m.setAccessible(true);
        java.security.interfaces.ECPublicKey derived = (java.security.interfaces.ECPublicKey) m.invoke(null, kp.getPrivate());
        assertEquals(((java.security.interfaces.ECPublicKey) kp.getPublic()).getW(), derived.getW());
    }

    @Test void phoneNormalisation() {
        assertEquals("+919800000001", Phone.parse("098000 00001", "+91").e164());
        assertEquals("+14155550100", Phone.parse("+1 (415) 555-0100", "+91").e164());
        assertThrows(com.communityos.api.shared.domain.DomainException.class, () -> Phone.parse("12345", "+91"));
        assertEquals("+91•••••00001", Phone.parse("9800000001", "+91").masked());
    }
}
