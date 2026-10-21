package com.communityos.api.shared.jdbc;

import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.security.Caller;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The append-only audit trail. `at` and the actor id are stamped by the database; secret-looking fields are written as "[redacted]". */
public final class JdbcAuditWriter implements AuditWriter {
    static final String INSERT = """
        INSERT INTO audit.audit_event (community_id, actor_id, actor_label, action, entity, entity_id, entity_short_id, unit_id, summary, changes, request_id)
        VALUES (CAST(:community AS uuid), CAST(:actor AS uuid), :label, :action, :entity, CAST(:entityId AS uuid), :shortId, CAST(:unitId AS uuid), left(:summary, 2000),
                CAST(:changes AS jsonb), :requestId)""";
    private static final Pattern SECRET = Pattern.compile("(?i).*(password|secret|token|otp|code_?hash|pin|cvv|card).*");

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcAuditWriter(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public void write(Caller caller, Action action, String entity, UUID entityId, String entityShortId, UUID unitId, String summary, List<Change> changes) {
        List<Change> safe = changes.stream().map((c) -> SECRET.matcher(c.field()).matches() ? new Change(c.field(), "[redacted]", "[redacted]") : c).toList();
        Map<String, Object> p = new HashMap<>();
        p.put("community", caller.community().toString());
        p.put("actor", caller.membership() == null ? null : caller.membership().toString());
        p.put("label", caller.label()); p.put("action", action.name()); p.put("entity", entity);
        p.put("entityId", entityId == null ? null : entityId.toString()); p.put("shortId", entityShortId);
        p.put("unitId", unitId == null ? null : unitId.toString()); p.put("summary", summary);
        p.put("requestId", org.slf4j.MDC.get("requestId"));
        try { p.put("changes", json.writeValueAsString(safe)); } catch (Exception e) { throw new IllegalStateException(e); }
        jdbc.update(INSERT, p);
    }
}
