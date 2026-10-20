package com.communityos.auth;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.Optional;
import java.util.OptionalInt;

/**
 * PORT: where sign-in keeps its state: the attempts counted for rate limits and lock-outs, the one-time codes (only a salted hash) and the sessions (only a
 * hash of the refresh token). Tables auth_attempts, auth_codes and sessions of db/V2__auth.sql (JdbcAuthStore), or memory (InMemoryAuthStore).
 */
public interface AuthStore {
    /** How many attempts were noted under this key in the last `seconds`. */
    int attempts(String key, long seconds);
    void note(String key);

    record Code(long id, String salt, String hash, int tries, Instant expiresAt, Instant createdAt) {}
    /** The newest code not used yet. */
    Optional<Code> latestCode(String tenant, String phone);
    /** When the newest code (used or not) was made. */
    Optional<Instant> lastCodeAt(String tenant, String phone);
    /** Every open code of this phone is used up (a new one replaces them). */
    void retireCodes(String tenant, String phone);
    void addCode(String tenant, String phone, String salt, String hash, Instant expiresAt);
    void useCode(long id);
    /** tries + 1, only while tries < max (two guesses at the same moment cannot both pass the limit). @return the new count, empty when the limit was reached */
    OptionalInt bumpTries(long id, int max);

    record Session(String id, String tenant, String userId, String roleId, String refreshHash, boolean demo, JsonNode profile, Instant expiresAt, Instant revokedAt) {}
    void addSession(Session s, String ip);
    /** The session whose current OR an earlier refresh token has this hash. */
    Optional<Session> sessionByRefresh(String hash);
    Optional<Session> session(String id);
    void revoke(String id);
    /** The current refresh hash joins the used ones (the last 100 are kept) and `next` becomes current. */
    void rotate(String id, String next);
    /** The role the session acts as, and (when not null) its unit. */
    void switchRole(String id, String roleId, String unit);
    void revokeByRefresh(String hash);
}
