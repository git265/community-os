package com.communityos.api.shared.jdbc;

import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.events.OutboxWriter;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Writes the event into integration.outbox_event on the request's connection, i.e. in the same transaction as the change. */
public final class JdbcOutboxWriter implements OutboxWriter {
    static final String INSERT = """
        INSERT INTO integration.outbox_event (community_id, topic, aggregate_type, aggregate_id, payload)
        VALUES (CAST(:community AS uuid), :topic, :aggregateType, CAST(:aggregateId AS uuid), CAST(:payload AS jsonb))""";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcOutboxWriter(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public void append(DomainEvent e) {
        String[] t = e.topic().split("\\.");
        try {
            jdbc.update(INSERT, Map.of("community", e.communityId().toString(), "topic", e.topic(), "aggregateType", t[0] + "." + t[1],
                "aggregateId", e.aggregateId().toString(), "payload", json.writeValueAsString(e)));
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) { throw new IllegalStateException(x); }
    }
}
