package com.communityos.api.auditlog;

import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * Reading the audit trail (audit.audit_event, written by every service through AuditWriter; append-only). One page at a time, newest first:
 * the trail grows with every change, so it is never sent whole. Who may read it: the Super Admin and anyone with VIEW_AUDIT_LOG.
 * Days are the community's own (its time zone).
 */
public final class AuditLog {
    public record Filter(String action, String area, String entity, UUID entityId, UUID unit, LocalDate from, LocalDate to, String q) {}
    public record Entry(UUID id, Instant at, String actor, String action, String entity, UUID entityId, String entityShortId, UUID unitId, String summary, JsonNode changes) {}

    static final String TZ = "(SELECT tzc.time_zone FROM platform.community tzc WHERE tzc.id = platform.current_community())";
    static final String LIST = """
        SELECT a.id, a.at, a.actor_label, a.action, a.entity, a.entity_id, a.entity_short_id, a.unit_id, a.summary, a.changes::text AS changes, count(*) OVER () AS total
        FROM audit.audit_event a
        WHERE a.community_id = platform.current_community()
          AND (CAST(:action AS text) IS NULL OR a.action = :action)
          AND (CAST(:area AS text) IS NULL OR split_part(a.entity, '.', 1) = :area)
          AND (CAST(:entity AS text) IS NULL OR a.entity = :entity)
          AND (CAST(:entityId AS uuid) IS NULL OR a.entity_id = CAST(:entityId AS uuid))
          AND (CAST(:unit AS uuid) IS NULL OR a.unit_id = CAST(:unit AS uuid))
          AND (CAST(:from AS date) IS NULL OR a.at >= (CAST(:from AS date)::timestamp AT TIME ZONE %1$s))
          AND (CAST(:to AS date) IS NULL OR a.at < ((CAST(:to AS date) + 1)::timestamp AT TIME ZONE %1$s))
          AND (CAST(:q AS text) IS NULL OR a.summary ILIKE :q ESCAPE '\\' OR a.actor_label ILIKE :q ESCAPE '\\' OR a.entity_short_id ILIKE :q ESCAPE '\\')
        ORDER BY a.at DESC, a.id DESC LIMIT :limit OFFSET :offset""".formatted(TZ);

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public AuditLog(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    public Page<Entry> list(Caller c, Filter f, PageQuery page) {
        if (!c.isSuperAdmin() && !c.has(Permission.VIEW_AUDIT_LOG)) throw new AccessDenied("Only the office can read the audit trail");
        Map<String, Object> p = new HashMap<>();
        p.put("action", blank(f.action())); p.put("area", blank(f.area()));
        p.put("entity", blank(f.entity())); p.put("entityId", f.entityId() == null ? null : f.entityId().toString()); p.put("unit", f.unit() == null ? null : f.unit().toString());
        p.put("from", Rows.sqlDate(f.from())); p.put("to", Rows.sqlDate(f.to()));
        p.put("q", blank(f.q()) == null ? null : Rows.like(f.q().strip())); p.put("limit", page.limit()); p.put("offset", page.offset());
        long[] total = {0};
        List<Entry> rows = jdbc.query(LIST, p, (rs, i) -> {
            total[0] = rs.getLong("total");
            JsonNode changes;
            try { changes = json.readTree(rs.getString("changes")); } catch (Exception e) { changes = json.createArrayNode(); }
            return new Entry(Rows.uuid(rs, "id"), Rows.instant(rs, "at"), rs.getString("actor_label"), rs.getString("action"), rs.getString("entity"), Rows.uuid(rs, "entity_id"),
                rs.getString("entity_short_id"), Rows.uuid(rs, "unit_id"), rs.getString("summary"), changes);
        });
        return new Page<>(rows, total[0], page.limit(), page.offset());
    }
    private static String blank(String s) { return s == null || s.isBlank() ? null : s.strip(); }
}
