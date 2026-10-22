package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.InboundEvents;
import com.communityos.api.billing.application.port.OrderLocator;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.jdbc.Rows;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Cross-community lookups for webhooks and reconciliation (platform connection), and the inbound de-duplication table. */
public final class JdbcPlatformPayments implements OrderLocator, InboundEvents {
    static final String BY_REF = "SELECT community_id, id FROM billing.payment_order WHERE provider = :provider AND provider_order_ref = :ref";
    static final String OPEN = """
        SELECT community_id, id FROM billing.payment_order WHERE status IN ('Created', 'Pending') AND updated_at < CAST(:before AS timestamptz) ORDER BY updated_at LIMIT :limit""";
    static final String CLOSED = """
        SELECT community_id, id FROM billing.payment_order WHERE status IN ('Expired', 'Failed') AND provider_order_ref IS NOT NULL AND created_at > now() - interval '7 days'
          AND (checked_at IS NULL OR checked_at < now() - interval '1 hour') ORDER BY coalesce(checked_at, created_at) LIMIT :limit""";
    static final String PROCESSED = "SELECT EXISTS (SELECT 1 FROM integration.inbound_event WHERE provider = :provider AND event_id = :event AND processed_at IS NOT NULL)";
    static final String RECEIVED = """
        INSERT INTO integration.inbound_event (provider, event_id, community_id, type) VALUES (:provider, :event, CAST(:community AS uuid), :type)
        ON CONFLICT (provider, event_id) DO NOTHING""";
    static final String MARK = "UPDATE integration.inbound_event SET processed_at = now() WHERE provider = :provider AND event_id = :event";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcPlatformPayments(NamedParameterJdbcTemplate platformJdbc) { this.jdbc = platformJdbc; }

    @Override public Optional<Located> byProviderRef(String provider, String ref) {
        return jdbc.query(BY_REF, Map.of("provider", provider, "ref", ref), (rs, i) -> new Located(new CommunityId(Rows.uuid(rs, "community_id")), new OrderId(Rows.uuid(rs, "id")))).stream().findFirst();
    }
    @Override public List<Located> openOlderThan(Instant before, int limit) {
        return jdbc.query(OPEN, Map.of("before", Rows.ts(before), "limit", limit), (rs, i) -> new Located(new CommunityId(Rows.uuid(rs, "community_id")), new OrderId(Rows.uuid(rs, "id"))));
    }
    @Override public List<Located> closedToCheck(int limit) {
        return jdbc.query(CLOSED, Map.of("limit", limit), (rs, i) -> new Located(new CommunityId(Rows.uuid(rs, "community_id")), new OrderId(Rows.uuid(rs, "id"))));
    }
    @Override public boolean alreadyProcessed(String provider, String event) { return Boolean.TRUE.equals(jdbc.queryForObject(PROCESSED, Map.of("provider", provider, "event", event), Boolean.class)); }
    @Override public void received(String provider, String event, UUID community, String type) {
        Map<String, Object> p = new HashMap<>(); p.put("provider", provider); p.put("event", event); p.put("community", community == null ? null : community.toString()); p.put("type", type);
        jdbc.update(RECEIVED, p);
    }
    @Override public void markProcessed(String provider, String event) { jdbc.update(MARK, Map.of("provider", provider, "event", event)); }
}
