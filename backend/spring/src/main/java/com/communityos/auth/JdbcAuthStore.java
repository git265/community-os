package com.communityos.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalInt;
import org.springframework.jdbc.core.JdbcTemplate;

/** Sign-in state in PostgreSQL: the same tables and statements as backend/contract-server/auth.mjs (db/V2__auth.sql), so the two servers share sessions. */
public class JdbcAuthStore implements AuthStore {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public JdbcAuthStore(JdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    private static Instant ts(Object o) { return o == null ? null : o instanceof Timestamp t ? t.toInstant() : o instanceof java.time.OffsetDateTime d ? d.toInstant() : Instant.parse(String.valueOf(o)); }

    @Override public int attempts(String key, long seconds) {
        Long n = jdbc.queryForObject("SELECT count(*) FROM auth_attempts WHERE key = ? AND at > now() - make_interval(secs => ?)", Long.class, key, (double) seconds);
        return n == null ? 0 : n.intValue();
    }
    @Override public void note(String key) { jdbc.update("INSERT INTO auth_attempts (key) VALUES (?)", key); }

    @Override public Optional<Code> latestCode(String tenant, String phone) {
        List<Map<String, Object>> r = jdbc.queryForList("SELECT id, salt, code_hash, tries, expires_at, created_at FROM auth_codes WHERE tenant = ? AND phone = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1", tenant, phone);
        if (r.isEmpty()) return Optional.empty();
        Map<String, Object> m = r.get(0);
        return Optional.of(new Code(((Number) m.get("id")).longValue(), (String) m.get("salt"), (String) m.get("code_hash"), ((Number) m.get("tries")).intValue(), ts(m.get("expires_at")), ts(m.get("created_at"))));
    }
    @Override public Optional<Instant> lastCodeAt(String tenant, String phone) {
        List<Map<String, Object>> r = jdbc.queryForList("SELECT created_at FROM auth_codes WHERE tenant = ? AND phone = ? ORDER BY created_at DESC LIMIT 1", tenant, phone);
        return r.isEmpty() ? Optional.empty() : Optional.of(ts(r.get(0).get("created_at")));
    }
    @Override public void retireCodes(String tenant, String phone) { jdbc.update("UPDATE auth_codes SET used_at = now() WHERE tenant = ? AND phone = ? AND used_at IS NULL", tenant, phone); }
    @Override public void addCode(String tenant, String phone, String salt, String hash, Instant expiresAt) {
        jdbc.update("INSERT INTO auth_codes (tenant, phone, salt, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)", tenant, phone, salt, hash, Timestamp.from(expiresAt));
    }
    @Override public void useCode(long id) { jdbc.update("UPDATE auth_codes SET used_at = now() WHERE id = ? AND used_at IS NULL", id); }
    @Override public OptionalInt bumpTries(long id, int max) {
        List<Integer> r = jdbc.queryForList("UPDATE auth_codes SET tries = tries + 1 WHERE id = ? AND tries < ? RETURNING tries", Integer.class, id, max);
        return r.isEmpty() ? OptionalInt.empty() : OptionalInt.of(r.get(0));
    }

    @Override public void addSession(Session s, String ip) {
        jdbc.update("INSERT INTO sessions (id, tenant, user_id, role_id, refresh_hash, demo, profile, ip, expires_at) VALUES (?::uuid, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)",
                s.id(), s.tenant(), s.userId(), s.roleId(), s.refreshHash(), s.demo(), s.profile() == null ? null : s.profile().toString(), ip, Timestamp.from(s.expiresAt()));
    }
    private Optional<Session> one(String where, Object... args) {
        List<Map<String, Object>> r = jdbc.queryForList("SELECT id::text AS id, tenant, user_id, role_id, refresh_hash, demo, profile::text AS profile, expires_at, revoked_at FROM sessions WHERE " + where, args);
        if (r.isEmpty()) return Optional.empty();
        Map<String, Object> m = r.get(0);
        JsonNode profile = null;
        try { if (m.get("profile") != null) profile = json.readTree((String) m.get("profile")); } catch (Exception e) { profile = null; }
        return Optional.of(new Session((String) m.get("id"), (String) m.get("tenant"), (String) m.get("user_id"), (String) m.get("role_id"), (String) m.get("refresh_hash"),
                Boolean.TRUE.equals(m.get("demo")), profile, ts(m.get("expires_at")), ts(m.get("revoked_at"))));
    }
    @Override public Optional<Session> sessionByRefresh(String hash) { return one("refresh_hash = ? OR used_hashes @> ARRAY[?]::text[] LIMIT 1", hash, hash); }
    @Override public Optional<Session> session(String id) {
        try { java.util.UUID.fromString(id); } catch (RuntimeException e) { return Optional.empty(); }   // a token with a made-up sid
        return one("id = ?::uuid", id);
    }
    @Override public void revoke(String id) { jdbc.update("UPDATE sessions SET revoked_at = now() WHERE id = ?::uuid AND revoked_at IS NULL", id); }
    @Override public void rotate(String id, String next) {
        jdbc.update("UPDATE sessions SET used_hashes = (used_hashes || refresh_hash)[GREATEST(1, cardinality(used_hashes || refresh_hash) - 99):cardinality(used_hashes || refresh_hash)], refresh_hash = ?, last_used_at = now() WHERE id = ?::uuid", next, id);
    }
    @Override public void switchRole(String id, String roleId, String unit) {
        jdbc.update("UPDATE sessions SET role_id = ?, profile = COALESCE(profile, '{}'::jsonb) || ?::jsonb WHERE id = ?::uuid", roleId, unit == null ? "{}" : json.createObjectNode().put("unit", unit).toString(), id);
    }
    @Override public void revokeByRefresh(String hash) { jdbc.update("UPDATE sessions SET revoked_at = now() WHERE (refresh_hash = ? OR used_hashes @> ARRAY[?]::text[]) AND revoked_at IS NULL", hash, hash); }
}
