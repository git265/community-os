package com.communityos.api.identity.adapter;

import com.communityos.api.identity.application.port.OtpStore;
import com.communityos.api.identity.domain.OtpChallenge;
import com.communityos.api.identity.domain.Phone;
import com.communityos.api.shared.jdbc.Rows;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** identity.otp_challenge on the platform connection (the API role has no access to it at all). */
public final class JdbcOtpStore implements OtpStore {
    static final String INSERT = """
        INSERT INTO identity.otp_challenge (id, phone_e164, purpose, code_hash, max_attempts, expires_at, ip)
        VALUES (CAST(:id AS uuid), :phone, 'login', :hash, :max, CAST(:expires AS timestamptz), CAST(:ip AS inet))""";
    static final String FIND_FOR_UPDATE = """
        SELECT id, phone_e164, code_hash, attempts, max_attempts, expires_at, consumed_at FROM identity.otp_challenge
        WHERE id = CAST(:id AS uuid) AND purpose = 'login' FOR UPDATE""";
    static final String ATTEMPT = "UPDATE identity.otp_challenge SET attempts = least(attempts + 1, 10) WHERE id = CAST(:id AS uuid)";
    static final String CONSUME = "UPDATE identity.otp_challenge SET consumed_at = CAST(:at AS timestamptz) WHERE id = CAST(:id AS uuid) AND consumed_at IS NULL";
    static final String PURGE = "DELETE FROM identity.otp_challenge WHERE expires_at < CAST(:before AS timestamptz)";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcOtpStore(NamedParameterJdbcTemplate platformJdbc) { this.jdbc = platformJdbc; }

    @Override public void save(OtpChallenge c, String ip) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", c.id().toString()); p.put("phone", c.phone().e164()); p.put("hash", c.codeHash()); p.put("max", c.maxAttempts());
        p.put("expires", Rows.ts(c.expiresAt())); p.put("ip", ip);
        jdbc.update(INSERT, p);
    }
    @Override public Optional<OtpChallenge> findForUpdate(UUID id) {
        return jdbc.query(FIND_FOR_UPDATE, Map.of("id", id.toString()), (rs, i) -> new OtpChallenge(Rows.uuid(rs, "id"), new Phone(rs.getString("phone_e164")),
            rs.getBytes("code_hash"), rs.getInt("attempts"), rs.getInt("max_attempts"), Rows.instant(rs, "expires_at"), Rows.instant(rs, "consumed_at"))).stream().findFirst();
    }
    @Override public void recordAttempt(UUID id) { jdbc.update(ATTEMPT, Map.of("id", id.toString())); }
    @Override public boolean consume(UUID id, Instant at) { return jdbc.update(CONSUME, Map.of("id", id.toString(), "at", Rows.ts(at))) == 1; }
    @Override public int purgeExpired(Instant before) { return jdbc.update(PURGE, Map.of("before", Rows.ts(before))); }
}
