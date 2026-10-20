package com.communityos.outbox;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;

public class JdbcEventOutboxStore implements EventOutboxStore {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public JdbcEventOutboxStore(JdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public void emit(String tenant, String topic, JsonNode payload) {
        jdbc.update("INSERT INTO event_outbox (tenant, topic, payload) VALUES (?,?,?::jsonb)", tenant, topic, (payload == null ? json.createObjectNode() : payload).toString());
    }

    @Override public List<OutboxEvent> lockDue(int limit) {
        return jdbc.query("SELECT id, tenant, topic, payload, attempts, created_at FROM event_outbox WHERE status='Pending' AND next_attempt_at <= now() ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
                (rs, i) -> {
                    try {
                        return new OutboxEvent(rs.getLong("id"), rs.getString("tenant"), rs.getString("topic"), json.readTree(rs.getString("payload")), rs.getInt("attempts"),
                                rs.getTimestamp("created_at").toInstant());
                    } catch (Exception e) { throw new IllegalStateException("Unreadable payload in event_outbox", e); }
                }, limit);
    }

    @Override public void markSent(long id) {
        jdbc.update("UPDATE event_outbox SET status='Sent', sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=?", id);
    }

    @Override public void markRetry(long id, int attempts, String error, long delaySeconds) {
        jdbc.update("UPDATE event_outbox SET attempts=?, last_error=?, next_attempt_at=now() + make_interval(secs => ?) WHERE id=?", attempts, error, (double) delaySeconds, id);
    }

    @Override public void markDead(long id, int attempts, String error) {
        jdbc.update("UPDATE event_outbox SET status='Dead', attempts=?, last_error=? WHERE id=?", attempts, error, id);
    }

    @Override public Map<String, Long> counts() {
        Map<String, Long> out = new LinkedHashMap<>();
        jdbc.query("SELECT status, count(*) AS n FROM event_outbox GROUP BY status", rs -> { out.put(rs.getString("status"), rs.getLong("n")); });
        return out;
    }
}
