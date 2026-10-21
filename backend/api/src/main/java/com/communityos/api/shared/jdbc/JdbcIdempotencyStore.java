package com.communityos.api.shared.jdbc;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.web.Idempotency;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * integration.idempotency_key, on the request's (tenant) connection. `begin` runs outside the business transaction (auto-commit) so a second
 * attempt sees the InFlight row at once; `complete` stores the reply. Keys of system callers are keyed on the community id.
 */
public final class JdbcIdempotencyStore implements Idempotency.Store {
    static final String BEGIN = """
        INSERT INTO integration.idempotency_key (community_id, principal_id, key, request_hash) VALUES (CAST(:community AS uuid), CAST(:principal AS uuid), :key, :hash)
        ON CONFLICT (community_id, principal_id, key) DO NOTHING""";
    static final String FIND = """
        SELECT request_hash, state, response_status, response_body FROM integration.idempotency_key
        WHERE community_id = CAST(:community AS uuid) AND principal_id = CAST(:principal AS uuid) AND key = :key AND created_at > now() - interval '24 hours'""";
    static final String COMPLETE = """
        UPDATE integration.idempotency_key SET state = 'Done', response_status = :status, response_body = :body
        WHERE community_id = CAST(:community AS uuid) AND principal_id = CAST(:principal AS uuid) AND key = :key""";
    static final String ABANDON = "DELETE FROM integration.idempotency_key WHERE community_id = CAST(:community AS uuid) AND principal_id = CAST(:principal AS uuid) AND key = :key AND state = 'InFlight'";
    static final String PURGE = "DELETE FROM integration.idempotency_key WHERE created_at < now() - interval '24 hours'";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcIdempotencyStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    private static Map<String, Object> keyOf(Caller c, String key) {
        Map<String, Object> m = new HashMap<>();
        m.put("community", c.community().toString());
        m.put("principal", (c.membership() == null ? c.community().value() : c.membership().value()).toString());
        m.put("key", key);
        return m;
    }
    @Override public boolean begin(Caller c, String key, byte[] hash) { Map<String, Object> m = keyOf(c, key); m.put("hash", hash); return jdbc.update(BEGIN, m) == 1; }
    @Override public Optional<Idempotency.Stored> find(Caller c, String key) {
        return jdbc.query(FIND, keyOf(c, key), (rs, i) -> new Idempotency.Stored(rs.getBytes("request_hash"), "Done".equals(rs.getString("state")),
            rs.getInt("response_status"), rs.getBytes("response_body"))).stream().findFirst();
    }
    @Override public void complete(Caller c, String key, int status, byte[] body) { Map<String, Object> m = keyOf(c, key); m.put("status", status); m.put("body", body); jdbc.update(COMPLETE, m); }
    @Override public void abandon(Caller c, String key) { jdbc.update(ABANDON, keyOf(c, key)); }
}
