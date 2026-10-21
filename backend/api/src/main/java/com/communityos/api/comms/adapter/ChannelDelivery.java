package com.communityos.api.comms.adapter;

import com.communityos.api.comms.application.port.ChannelSender;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * Delivers the queued channel messages of every community (the platform connection). A batch is claimed in one statement (SKIP LOCKED, and a
 * two-minute lease in the row) so several instances can run it; a message that fails is tried again on later runs, up to MAX_ATTEMPTS, then
 * marked Failed with the provider's reason.
 */
public final class ChannelDelivery {
    public static final int MAX_ATTEMPTS = 5;
    static final String CLAIM = """
        UPDATE comms.outbox_message m SET attempts = m.attempts + 1, custom = m.custom || jsonb_build_object('leaseUntil', now() + interval '2 minutes')
        WHERE (m.community_id, m.created_at, m.id) IN (
          SELECT community_id, created_at, id FROM comms.outbox_message
          WHERE status = 'Queued' AND attempts < :max AND coalesce(CAST(custom ->> 'leaseUntil' AS timestamptz), '-infinity') < now()
          ORDER BY created_at LIMIT :batch FOR UPDATE SKIP LOCKED)
        RETURNING m.community_id, m.created_at::text AS created_at, m.id, m.channel, m.to_value, m.subject, m.body, m.attempts""";
    static final String SENT = """
        UPDATE comms.outbox_message SET status = 'Sent', sent_at = now(), error = NULL, custom = (custom - 'leaseUntil') || jsonb_build_object('provider', CAST(:provider AS text), 'ref', CAST(:ref AS text))
        WHERE community_id = CAST(:c AS uuid) AND created_at = CAST(:at AS timestamptz) AND id = CAST(:id AS uuid)""";
    static final String FAILED = """
        UPDATE comms.outbox_message SET error = left(:error, 500), status = CASE WHEN attempts >= :max THEN 'Failed' ELSE 'Queued' END
        WHERE community_id = CAST(:c AS uuid) AND created_at = CAST(:at AS timestamptz) AND id = CAST(:id AS uuid)""";

    record Row(UUID community, String createdAt, UUID id, String channel, String to, String subject, String body) {}
    private final NamedParameterJdbcTemplate platform; private final ChannelSender sender;
    public ChannelDelivery(NamedParameterJdbcTemplate platform, ChannelSender sender) { this.platform = platform; this.sender = sender; }

    /** One batch; returns how many messages were tried. */
    public int runOnce(int batch) {
        {
            List<Row> rows = platform.query(CLAIM, Map.of("max", MAX_ATTEMPTS, "batch", batch), (rs, i) -> new Row(rs.getObject("community_id", UUID.class), rs.getString("created_at"),
                rs.getObject("id", UUID.class), rs.getString("channel"), rs.getString("to_value"), rs.getString("subject"), rs.getString("body")));
            for (Row r : rows) {
                ChannelSender.Result res;
                try { res = sender.send(r.channel(), r.to(), r.subject(), r.body()); }
                catch (RuntimeException e) { res = ChannelSender.Result.failed(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()); }
                Map<String, Object> key = new java.util.HashMap<>(Map.of("c", r.community().toString(), "at", r.createdAt(), "id", r.id().toString()));
                if (res.sent()) { key.put("provider", sender.name()); key.put("ref", res.providerRef() == null ? "" : res.providerRef()); platform.update(SENT, key); }
                else { key.put("error", res.error() == null ? "not sent" : res.error()); key.put("max", MAX_ATTEMPTS); platform.update(FAILED, key); }
            }
            return rows.size();
        }
    }
}
