package com.communityos.api.comms.adapter;

import com.communityos.api.comms.application.port.PushSender;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * Sends the queued push messages of every community (the platform connection; a batch is claimed in one statement with SKIP LOCKED and a
 * lease, so several instances can run it). Delivered -> Sent; the push service says the subscription is gone -> it is removed; busy or
 * unreachable -> tried again later, up to MAX_ATTEMPTS; anything else -> Failed.
 */
public final class PushDelivery {
    public static final int MAX_ATTEMPTS = 5;
    static final String CLAIM = """
        UPDATE comms.push_queue q SET attempts = q.attempts + 1, lease_until = now() + interval '2 minutes'
        WHERE (q.community_id, q.id) IN (
          SELECT community_id, id FROM comms.push_queue
          WHERE status = 'Queued' AND attempts < :max AND (lease_until IS NULL OR lease_until < now()) AND created_at > now() - interval '1 day'
          ORDER BY created_at LIMIT :batch FOR UPDATE SKIP LOCKED)
        RETURNING q.community_id, q.id, q.subscription_id, q.notification_id, q.title, q.body, q.link, q.attempts,
                  (SELECT s.endpoint FROM comms.push_subscription s WHERE s.community_id = q.community_id AND s.id = q.subscription_id) AS endpoint,
                  (SELECT s.p256dh FROM comms.push_subscription s WHERE s.community_id = q.community_id AND s.id = q.subscription_id) AS p256dh,
                  (SELECT s.auth FROM comms.push_subscription s WHERE s.community_id = q.community_id AND s.id = q.subscription_id) AS auth""";
    static final String SENT = """
        UPDATE comms.push_queue SET status = 'Sent', sent_at = now(), error = NULL, lease_until = NULL WHERE community_id = CAST(:c AS uuid) AND id = CAST(:id AS uuid)""";
    static final String TOUCH = "UPDATE comms.push_subscription SET last_sent_at = now() WHERE community_id = CAST(:c AS uuid) AND id = CAST(:sub AS uuid)";
    static final String RETRY = """
        UPDATE comms.push_queue SET error = left(:error, 500), lease_until = NULL, status = CASE WHEN attempts >= :max THEN 'Failed' ELSE 'Queued' END
        WHERE community_id = CAST(:c AS uuid) AND id = CAST(:id AS uuid)""";
    static final String FAILED = "UPDATE comms.push_queue SET status = 'Failed', error = left(:error, 500), lease_until = NULL WHERE community_id = CAST(:c AS uuid) AND id = CAST(:id AS uuid)";
    static final String GONE = "DELETE FROM comms.push_subscription WHERE community_id = CAST(:c AS uuid) AND id = CAST(:sub AS uuid)";

    record Row(UUID community, UUID id, UUID subscription, UUID notification, String title, String body, String link, String endpoint, String p256dh, String auth) {}
    private final NamedParameterJdbcTemplate platform; private final PushSender sender;
    public PushDelivery(NamedParameterJdbcTemplate platform, PushSender sender) { this.platform = platform; this.sender = sender; }
    public PushSender sender() { return sender; }

    /** One batch; returns how many messages were tried. */
    public int runOnce(int batch) {
        List<Row> rows = platform.query(CLAIM, Map.of("max", MAX_ATTEMPTS, "batch", batch), (rs, i) -> new Row(rs.getObject("community_id", UUID.class), rs.getObject("id", UUID.class),
            rs.getObject("subscription_id", UUID.class), rs.getObject("notification_id", UUID.class), rs.getString("title"), rs.getString("body"), rs.getString("link"),
            rs.getString("endpoint"), rs.getString("p256dh"), rs.getString("auth")));
        for (Row r : rows) {
            Map<String, Object> key = new HashMap<>(Map.of("c", r.community().toString(), "id", r.id().toString(), "sub", r.subscription().toString(), "max", MAX_ATTEMPTS));
            if (r.endpoint() == null) { key.put("error", "the subscription was removed"); platform.update(FAILED, key); continue; }
            PushSender.Result res;
            try { res = sender.send(new PushSender.Subscription(r.endpoint(), r.p256dh(), r.auth()), new PushSender.Message(r.title(), r.body() == null ? "" : r.body(), r.link(), r.notification().toString())); }
            catch (RuntimeException e) { res = new PushSender.Result(0, e.getMessage()); }
            if (res.delivered()) { platform.update(SENT, key); platform.update(TOUCH, key); }
            else if (res.gone()) platform.update(GONE, key);                       // its queue rows go with it (ON DELETE CASCADE)
            else { key.put("error", res.error() == null ? "HTTP " + res.status() : res.error()); platform.update(res.retry() ? RETRY : FAILED, key); }
        }
        return rows.size();
    }
}
