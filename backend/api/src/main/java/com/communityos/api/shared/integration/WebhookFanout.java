package com.communityos.api.shared.integration;

import com.communityos.api.shared.events.EventPublisher;
import com.communityos.api.shared.events.OutboxMessage;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * EventPublisher for outgoing webhooks: one outbox event becomes one delivery row per matching subscription (idempotent: unique per
 * subscription and event), so a slow or dead receiver only delays its own deliveries, never the others or the outbox.
 */
public final class WebhookFanout implements EventPublisher {
    static final String FAN_OUT = """
        INSERT INTO integration.webhook_delivery (community_id, subscription_id, event_id)
        SELECT s.community_id, s.id, CAST(:event AS uuid) FROM integration.webhook_subscription s
        WHERE s.community_id = CAST(:community AS uuid) AND s.active AND CAST(:topic AS text) = ANY (s.topics)
        ON CONFLICT (subscription_id, event_id) DO NOTHING""";
    private final NamedParameterJdbcTemplate jdbc;
    public WebhookFanout(NamedParameterJdbcTemplate platformJdbc) { this.jdbc = platformJdbc; }

    @Override public void publish(OutboxMessage m) {
        jdbc.update(FAN_OUT, Map.of("event", m.eventId().toString(), "community", m.communityId().toString(), "topic", m.topic()));
    }
}
