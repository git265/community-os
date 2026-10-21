package com.communityos.api.shared.jdbc;

import com.communityos.api.shared.events.OutboxMessage;
import com.communityos.api.shared.events.OutboxRelay;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * The relay's view of the outbox, on the PLATFORM connection (it serves every community). Claiming leases the rows for 60 s in one statement
 * (FOR UPDATE SKIP LOCKED), so several API instances share the work, no lock is held while a receiver is called, and a crashed instance's
 * rows come back after the lease.
 */
public final class JdbcOutboxStore implements OutboxRelay.Store {
    static final String CLAIM = """
        UPDATE integration.outbox_event o SET next_attempt_at = CAST(:now AS timestamptz) + interval '60 seconds'
        WHERE o.id IN (SELECT id FROM integration.outbox_event WHERE status = 'Pending' AND next_attempt_at <= CAST(:now AS timestamptz)
                       ORDER BY next_attempt_at LIMIT :batch FOR UPDATE SKIP LOCKED)
        RETURNING o.id, o.event_id, o.community_id, o.topic, o.aggregate_type, o.aggregate_id, o.payload::text AS payload, o.attempts, o.created_at""";
    static final String SENT = "UPDATE integration.outbox_event SET status = 'Sent', sent_at = CAST(:at AS timestamptz), last_error = NULL WHERE id = :id";
    static final String RETRY = "UPDATE integration.outbox_event SET attempts = :attempts, next_attempt_at = CAST(:next AS timestamptz), last_error = left(:error, 1000) WHERE id = :id";
    static final String DEAD = "UPDATE integration.outbox_event SET status = 'Dead', attempts = :attempts, last_error = left(:error, 1000) WHERE id = :id";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcOutboxStore(NamedParameterJdbcTemplate platformJdbc) { this.jdbc = platformJdbc; }

    @Override public List<OutboxMessage> claimDue(int batch, Instant now) {
        return jdbc.query(CLAIM, Map.of("now", Rows.ts(now), "batch", batch), (rs, i) -> new OutboxMessage(rs.getLong("id"), Rows.uuid(rs, "event_id"),
            Rows.uuid(rs, "community_id"), rs.getString("topic"), rs.getString("aggregate_type"), Rows.uuid(rs, "aggregate_id"), rs.getString("payload"),
            rs.getInt("attempts"), Rows.instant(rs, "created_at")));
    }
    @Override public void markSent(long id, Instant at) { jdbc.update(SENT, Map.of("id", id, "at", Rows.ts(at))); }
    @Override public void retryLater(long id, int attempts, Instant next, String error) { jdbc.update(RETRY, Map.of("id", id, "attempts", attempts, "next", Rows.ts(next), "error", error)); }
    @Override public void markDead(long id, int attempts, String error) { jdbc.update(DEAD, Map.of("id", id, "attempts", attempts, "error", error)); }
}
