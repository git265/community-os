package com.communityos.api.identity.application;

import com.communityos.api.identity.application.port.OtpSender;
import com.communityos.api.identity.application.port.OtpStore;
import com.communityos.api.identity.application.port.PersonDirectory;
import com.communityos.api.identity.application.port.PersonDirectory.MembershipRef;
import com.communityos.api.identity.application.port.RateLimiter;
import com.communityos.api.identity.application.port.RefreshTokenStore;
import com.communityos.api.identity.application.port.TokenIssuer;
import com.communityos.api.identity.domain.OtpChallenge;
import com.communityos.api.identity.domain.Phone;
import com.communityos.api.identity.domain.RefreshToken;
import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.security.Unauthenticated;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Sign-in with a one-time code, then bearer tokens:
 *   1. requestCode(phone)              -> a challenge id; the code goes to the phone. The answer is the same for unknown numbers (no enumeration).
 *   2. verify(challenge, code[, cid])  -> access token (JWT, 10 min) + refresh token (opaque, 30 days, rotating). A person in several
 *                                         communities first gets the list and verifies again with the one they pick.
 *   3. refresh(token)                  -> a new pair; the old refresh token is spent. Re-using a spent one revokes the whole family.
 *   4. logout(token)                   -> the family is revoked.
 * Everything runs on the platform connection (sign-in happens before a community is known).
 */
public final class AuthService {
    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    public record Settings(String defaultCountryCode, Duration codeTtl, int maxAttempts, Duration refreshTtl, int codesPerPhone, int requestsPerIp, Duration window) {
        public static Settings defaults() { return new Settings("+91", Duration.ofMinutes(5), 5, Duration.ofDays(30), 5, 30, Duration.ofMinutes(15)); }
    }
    public record CodeRequested(UUID challengeId, long expiresInSeconds) {}
    public record Tokens(String accessToken, Instant accessExpiresAt, String refreshToken, Instant refreshExpiresAt, MembershipRef membership) {}
    /** verify() either signs in or asks which community. */
    public sealed interface VerifyResult permits SignedIn, ChooseCommunity {}
    public record SignedIn(Tokens tokens) implements VerifyResult {}
    public record ChooseCommunity(List<MembershipRef> memberships) implements VerifyResult {}
    public record Client(String userAgent, String ip) {}

    private final OtpStore otps; private final RefreshTokenStore refreshTokens; private final PersonDirectory people; private final OtpSender sender;
    private final RateLimiter limiter; private final TokenIssuer issuer; private final CodeHasher hasher; private final Tx platformTx; private final Clock clock;
    private final Settings settings;

    public AuthService(OtpStore otps, RefreshTokenStore refreshTokens, PersonDirectory people, OtpSender sender, RateLimiter limiter, TokenIssuer issuer,
                       CodeHasher hasher, Tx platformTx, Clock clock, Settings settings) {
        this.otps = otps; this.refreshTokens = refreshTokens; this.people = people; this.sender = sender; this.limiter = limiter; this.issuer = issuer;
        this.hasher = hasher; this.platformTx = platformTx; this.clock = clock; this.settings = settings;
    }

    public CodeRequested requestCode(String rawPhone, Client client) {
        io.micrometer.core.instrument.Metrics.counter("cos.auth.codes_requested").increment();
        Phone phone = Phone.parse(rawPhone, settings.defaultCountryCode());
        limiter.hit("otp-ip:" + client.ip(), settings.requestsPerIp(), settings.window());
        limiter.hit("otp-phone:" + phone.e164(), settings.codesPerPhone(), settings.window());
        UUID id = UUID.randomUUID();
        String code = Crypto.randomDigits(6);
        Optional<PersonDirectory.PersonRef> person = people.findActiveByPhone(phone);
        // an unknown number gets a challenge that can never match, and the same answer, so the response does not say who is a member
        byte[] hash = person.isPresent() && !people.activeMemberships(person.get().id()).isEmpty() ? hasher.hash(id, code) : Crypto.sha256(Crypto.randomToken(32));
        Instant now = clock.instant();
        otps.save(new OtpChallenge(id, phone, hash, 0, settings.maxAttempts(), now.plus(settings.codeTtl()), null), client.ip());
        if (person.isPresent()) {
            try { sender.send(phone, code); }
            catch (RuntimeException e) { log.warn("sign-in code to {} could not be sent: {}", phone.masked(), e.toString()); }
        }
        return new CodeRequested(id, settings.codeTtl().toSeconds());
    }

    public VerifyResult verify(UUID challengeId, String code, CommunityId chosen, Client client) {
        limiter.hit("verify-ip:" + client.ip(), settings.requestsPerIp(), settings.window());
        if (challengeId == null || code == null || !code.matches("[0-9]{6}")) throw new Unauthenticated();
        // 1. count the attempt and compare, and COMMIT that, so a wrong guess is counted even though the request then fails
        OtpChallenge matched = platformTx.inTx(() -> {
            Instant now = clock.instant();
            OtpChallenge c = otps.findForUpdate(challengeId).filter((x) -> x.usable(now)).orElse(null);
            if (c == null) return null;
            otps.recordAttempt(c.id());
            return hasher.matches(c.id(), code, c.codeHash()) ? c : null;
        });
        if (matched == null) throw new Unauthenticated();
        PersonDirectory.PersonRef person = people.findActiveByPhone(matched.phone()).orElseThrow(Unauthenticated::new);
        List<MembershipRef> memberships = people.activeMemberships(person.id());
        MembershipRef m;
        if (chosen != null) m = memberships.stream().filter((x) -> x.community().equals(chosen)).findFirst().orElseThrow(Unauthenticated::new);
        else if (memberships.size() == 1) m = memberships.get(0);
        else if (memberships.isEmpty()) throw new Unauthenticated();
        else return new ChooseCommunity(memberships);                         // the code stays usable for the second call
        // 2. spend the code (only one of two simultaneous correct submissions wins) and issue the tokens
        Tokens tokens = platformTx.inTx(() -> {
            Instant now = clock.instant();
            if (!otps.consume(matched.id(), now)) return null;
            return issue(person.id(), m, UUID.randomUUID(), client, now);
        });
        if (tokens == null) throw new Unauthenticated();
        return new SignedIn(tokens);
    }

    public Tokens refresh(String refreshToken, Client client) {
        if (refreshToken == null || refreshToken.length() < 20 || refreshToken.length() > 200) throw new Unauthenticated("Sign in again");
        limiter.hit("refresh-ip:" + client.ip(), settings.requestsPerIp() * 4, settings.window());
        byte[] hash = Crypto.sha256(refreshToken);
        // revocations must stick even though the request fails, so the transaction returns null instead of throwing
        Tokens out = platformTx.inTx(() -> {
            Instant now = clock.instant();
            RefreshToken t = refreshTokens.findByHashForUpdate(hash).orElse(null);
            if (t == null) return null;
            switch (t.check(now)) {
                case REUSED -> {
                    refreshTokens.revokeFamily(t.familyId(), "reuse-detected", now);
                    log.warn("refresh token re-used: family {} of membership {} revoked", t.familyId(), t.membership());
                    return null;
                }
                case EXPIRED, REVOKED -> { return null; }
                case OK -> { }
            }
            Optional<MembershipRef> m = people.isActive(t.person(), t.community(), t.membership())
                ? people.activeMemberships(t.person()).stream().filter((x) -> x.membership().equals(t.membership())).findFirst()
                : Optional.empty();
            if (m.isEmpty()) { refreshTokens.revokeFamily(t.familyId(), "membership-inactive", now); return null; }
            refreshTokens.markUsed(t.id(), now);
            return issue(t.person(), m.get(), t.familyId(), client, now);
        });
        if (out == null) throw new Unauthenticated("Sign in again");
        return out;
    }

    public void logout(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) return;
        platformTx.run(() -> refreshTokens.findByHashForUpdate(Crypto.sha256(refreshToken))
            .ifPresent((t) -> refreshTokens.revokeFamily(t.familyId(), "logout", clock.instant())));
    }

    /**
     * Development and demos only (DemoConfig, which refuses to start in prod): tokens for a member without a code, so a demo can be shown as
     * anyone on its roster. The membership must be active, like any other sign-in.
     */
    public Tokens demoSignIn(com.communityos.api.shared.domain.Ids.PersonId person, CommunityId community, com.communityos.api.shared.domain.Ids.MembershipId membership, Client client) {
        Tokens t = platformTx.inTx(() -> {
            MembershipRef m = people.activeMemberships(person).stream().filter((x) -> x.community().equals(community) && x.membership().equals(membership)).findFirst().orElse(null);
            return m == null ? null : issue(person, m, UUID.randomUUID(), client, clock.instant());
        });
        if (t == null) throw new Unauthenticated();
        return t;
    }

    private Tokens issue(com.communityos.api.shared.domain.Ids.PersonId person, MembershipRef m, UUID family, Client client, Instant now) {
        TokenIssuer.AccessToken access = issuer.issue(person, m.community(), m.membership());
        String refresh = Crypto.randomToken(32);
        Instant refreshExpires = now.plus(settings.refreshTtl());
        refreshTokens.save(new RefreshToken(UUID.randomUUID(), family, person, m.community(), m.membership(), Crypto.sha256(refresh), refreshExpires, null, null),
            client.userAgent(), client.ip());
        return new Tokens(access.value(), access.expiresAt(), refresh, refreshExpires, m);
    }
}
