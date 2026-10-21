package com.communityos.api.identity.adapter;

import com.communityos.api.identity.application.port.RateLimiter;
import com.communityos.api.shared.security.TooManyAttempts;
import java.time.Duration;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * Sliding-window limit over identity.auth_attempt, shared by every API instance: the attempt is recorded and counted in one round trip.
 * Requests racing in the same millisecond may overshoot by a few, which is fine for a brute-force limit (the code itself also allows only
 * 5 tries). At much higher volume this moves to Redis behind the same interface.
 */
public final class JdbcRateLimiter implements RateLimiter {
    static final String HIT = """
        WITH ins AS (INSERT INTO identity.auth_attempt (key) VALUES (:key) RETURNING 1)
        SELECT count(*) + 1 FROM identity.auth_attempt WHERE key = :key AND at > now() - make_interval(secs => :seconds)""";
    static final String PURGE = "DELETE FROM identity.auth_attempt WHERE at < now() - interval '1 day'";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcRateLimiter(NamedParameterJdbcTemplate platformJdbc) { this.jdbc = platformJdbc; }

    @Override public void hit(String key, int max, Duration window) {
        String k = key.length() > 200 ? key.substring(0, 200) : key;
        Long n = jdbc.queryForObject(HIT, Map.of("key", k, "seconds", (double) window.toSeconds()), Long.class);
        if (n != null && n > max) throw new TooManyAttempts(window.toSeconds());
    }
}
