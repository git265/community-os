package com.communityos.idempotency;

import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;

public class JdbcIdempotencyStore implements IdempotencyStore {
    private final JdbcTemplate jdbc;

    public JdbcIdempotencyStore(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public boolean begin(String tenant, String scope, String key, String hash) {
        return jdbc.update("INSERT INTO idempotency_keys (tenant, scope, key, request_hash) VALUES (?,?,?,?) ON CONFLICT DO NOTHING", tenant, scope, key, hash) > 0;
    }

    @Override public Optional<Entry> find(String tenant, String scope, String key) {
        return jdbc.query("SELECT request_hash, state, response_status, response_body FROM idempotency_keys WHERE tenant=? AND scope=? AND key=?",
                (rs, i) -> new Entry(rs.getString("request_hash"), rs.getString("state"), (Integer) rs.getObject("response_status"), rs.getString("response_body"), null),
                tenant, scope, key).stream().findFirst();
    }

    @Override public void complete(String tenant, String scope, String key, int status, String body) {
        jdbc.update("UPDATE idempotency_keys SET state='Done', response_status=?, response_body=? WHERE tenant=? AND scope=? AND key=?", status, body, tenant, scope, key);
    }

    @Override public void release(String tenant, String scope, String key) { jdbc.update("DELETE FROM idempotency_keys WHERE tenant=? AND scope=? AND key=?", tenant, scope, key); }

    @Override public int cleanup(int hours) { return jdbc.update("DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => ?)", hours); }
}
