package com.communityos.api.maintenance.adapter;

import com.communityos.api.maintenance.application.port.DispatchStore;
import com.communityos.api.maintenance.domain.Dispatch;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.jdbc.Rows;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Dispatch reads on the tenant connection: field staff and their load, a category's queue, the reminders already sent. */
public final class JdbcDispatchStore implements DispatchStore {
    /** a role-queue ticket (the maintenance tickets dispatch is for) */
    static final String QUEUE_TYPE = "EXISTS (SELECT 1 FROM maintenance.task_type tt WHERE tt.community_id = t.community_id AND tt.id = t.task_type_id AND tt.assignment_mode LIKE 'Role queue%')";
    static final String TECHS = """
        SELECT fs.membership_id, m.display_name, fs.clocked_in,
               (SELECT count(*) FROM maintenance.ticket t WHERE t.community_id = fs.community_id AND t.assignee_id = fs.membership_id AND t.status IN ('Assigned', 'In Progress')) AS busy,
               (SELECT max(t.assigned_at) FROM maintenance.ticket t WHERE t.community_id = fs.community_id AND t.assignee_id = fs.membership_id) AS last_assigned,
               (SELECT t.short_id FROM maintenance.ticket t WHERE t.community_id = fs.community_id AND t.assignee_id = fs.membership_id AND t.status IN ('Assigned', 'In Progress')
                 ORDER BY (t.status = 'In Progress') DESC, t.assigned_at LIMIT 1) AS working
        FROM maintenance.field_staff fs
        JOIN identity.membership m ON m.community_id = fs.community_id AND m.id = fs.membership_id AND m.status = 'Active'
        WHERE lower(fs.trade) = lower(:category)
        ORDER BY m.display_name""";
    static final String LOCK = "SELECT 1 AS x FROM (SELECT pg_advisory_xact_lock(hashtext('ticket-queue:' || CAST(platform.current_community() AS text) || ':' || lower(:category)))) l";
    static final String QUEUED = "SELECT t.id FROM maintenance.ticket t WHERE t.status = 'Open' AND t.assignee_id IS NULL AND lower(t.category) = lower(:category) AND "
        + QUEUE_TYPE + " ORDER BY t.created_at, t.id LIMIT :limit FOR UPDATE OF t SKIP LOCKED";
    static final String QUEUED_CATEGORIES = "SELECT DISTINCT t.category FROM maintenance.ticket t WHERE t.status = 'Open' AND t.assignee_id IS NULL AND " + QUEUE_TYPE + " ORDER BY t.category";
    static final String OFF_SHIFT = """
        SELECT t.id FROM maintenance.ticket t
        JOIN maintenance.field_staff fs ON fs.community_id = t.community_id AND fs.membership_id = t.assignee_id AND NOT fs.clocked_in AND lower(fs.trade) = lower(t.category)
        WHERE t.status = 'Assigned' AND t.started_at IS NULL AND\s""" + QUEUE_TYPE + " ORDER BY t.created_at";
    static final String ACTIVE = """
        SELECT t.id, t.short_id, t.title, t.category, t.status, t.assignee_id, a.display_name AS assignee_name, t.assigned_at, t.started_at, cc.start_within_min, cc.fix_within_hours
        FROM maintenance.ticket t
        JOIN identity.membership a ON a.community_id = t.community_id AND a.id = t.assignee_id
        LEFT JOIN maintenance.category_coverage cc ON cc.community_id = t.community_id AND lower(cc.category) = lower(t.category)
        WHERE t.status IN ('Assigned', 'In Progress') AND\s""" + QUEUE_TYPE + " ORDER BY t.assigned_at";
    static final String CLAIM = """
        INSERT INTO maintenance.ticket_nudge (community_id, ticket_id, kind, stage, since)
        VALUES (platform.current_community(), CAST(:ticket AS uuid), :kind, :stage, CAST(:since AS timestamptz))
        ON CONFLICT DO NOTHING RETURNING 1 AS x""";
    static final String VIEW = """
        SELECT t.id, t.short_id, t.title, t.category, t.priority, t.status, t.unit_id, u.unit_no, t.raised_by_id, t.assignee_id, a.display_name AS assignee_name,
               t.created_at, t.assigned_at, t.started_at, t.completed_at
        FROM maintenance.ticket t
        LEFT JOIN property.unit u ON u.community_id = t.community_id AND u.id = t.unit_id
        LEFT JOIN identity.membership a ON a.community_id = t.community_id AND a.id = t.assignee_id
        WHERE lower(t.category) = lower(:category) AND (t.created_at >= CAST(:since AS timestamptz) OR t.status IN ('Open', 'Assigned', 'In Progress', 'On Hold')) AND\s""" + QUEUE_TYPE + """

        ORDER BY t.created_at, t.id LIMIT 300""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcDispatchStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }
    private static Instant at(java.sql.ResultSet rs, String col) throws java.sql.SQLException { return Rows.instant(rs, col); }
    private static MembershipId member(java.sql.ResultSet rs, String col) throws java.sql.SQLException { UUID u = Rows.uuid(rs, col); return u == null ? null : new MembershipId(u); }
    private static Integer intOrNull(java.sql.ResultSet rs, String col) throws java.sql.SQLException { Object v = rs.getObject(col); return v instanceof Number n ? n.intValue() : v == null ? null : Integer.valueOf(v.toString()); }

    @Override public List<Dispatch.Tech> techs(String category) {
        return jdbc.query(TECHS, Map.of("category", category), (rs, i) -> new Dispatch.Tech(member(rs, "membership_id"), rs.getString("display_name"), rs.getBoolean("clocked_in"),
            rs.getInt("busy"), at(rs, "last_assigned"), rs.getString("working")));
    }
    @Override public void lock(String category) { jdbc.query(LOCK, Map.of("category", category), (rs, i) -> 1); }
    @Override public List<UUID> queued(String category, int limit) { return jdbc.query(QUEUED, Map.of("category", category, "limit", limit), (rs, i) -> Rows.uuid(rs, "id")); }
    @Override public List<String> queuedCategories() { return jdbc.query(QUEUED_CATEGORIES, Map.of(), (rs, i) -> rs.getString("category")); }
    @Override public List<UUID> offShiftAssigned() { return jdbc.query(OFF_SHIFT, Map.of(), (rs, i) -> Rows.uuid(rs, "id")); }
    @Override public List<Active> active() {
        return jdbc.query(ACTIVE, Map.of(), (rs, i) -> new Active(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("title"), rs.getString("category"), rs.getString("status"),
            member(rs, "assignee_id"), rs.getString("assignee_name"), at(rs, "assigned_at"), at(rs, "started_at"), intOrNull(rs, "start_within_min"), intOrNull(rs, "fix_within_hours")));
    }
    @Override public boolean claim(UUID ticket, String kind, int stage, Instant since) {
        return !jdbc.query(CLAIM, Map.of("ticket", ticket.toString(), "kind", kind, "stage", stage, "since", since.toString()), (rs, i) -> 1).isEmpty();
    }
    @Override public List<Row> queueView(String category, Instant since) {
        return jdbc.query(VIEW, Map.of("category", category, "since", since.toString()), (rs, i) -> new Row(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("title"),
            rs.getString("category"), rs.getString("priority"), rs.getString("status"), Rows.uuid(rs, "unit_id"), rs.getString("unit_no"), member(rs, "raised_by_id"),
            Rows.uuid(rs, "assignee_id"), rs.getString("assignee_name"), at(rs, "created_at"), at(rs, "assigned_at"), at(rs, "started_at"), at(rs, "completed_at")));
    }
}
