package com.communityos.api.maintenance.adapter;

import com.communityos.api.maintenance.application.port.TicketRepository;
import com.communityos.api.maintenance.domain.TaskType;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.maintenance.domain.TicketStatus;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** maintenance.ticket on the tenant connection, with its task type, unit, raiser and assignee joined in one query. */
public final class JdbcTicketRepository implements TicketRepository {
    static final String COLUMNS = """
        SELECT t.id, t.community_id, t.short_id, t.title, t.description, t.unit_id, u.unit_no, u.block_id, t.scope, t.location, t.category, t.sub_category, t.priority,
               t.status, t.assignee_id, a.display_name AS assignee_name, t.sla_due_at::date AS sla_due_at, t.preferred_time, t.affected_unit_ids, t.resident_rating,
               t.raised_by_id, r.display_name AS raised_by_name, rr.code AS raised_by_role, t.awaiting_parts, t.materials_cost, t.financial, t.work_done,
               t.assigned_at, t.started_at, t.completed_at, t.closed_at, t.cancelled_at, t.cancel_reason, t.reopen_count, t.custom::text AS custom, t.asset_id,
               (SELECT e.name FROM assets.equipment e WHERE e.community_id = t.community_id AND e.id = t.asset_id) AS asset_name,
               t.created_at, t.updated_at, t.version, t.quotation_status, t.invoice_status, t.approved_amount, t.selected_quotation_id, t.selected_invoice_id,
               t.ec_approval, t.treasurer_approval, t.final_required, t.ec_approved_at,
               (SELECT m.display_name FROM identity.membership m WHERE m.community_id = t.community_id AND m.id = t.ec_approved_by_id) AS ec_approved_by,
               tt.id AS tt_id, tt.name AS tt_name, tt.icon AS tt_icon, tt.creator_scope, tt.assignment_mode, tt.quotation_stage, tt.ec_approval_stage, tt.treasurer_stage,
               tt.invoice_stage, tt.payment_stage, tt.resident_visible, tt.resident_default, tt.active AS tt_active""";
    static final String FROM = """
        FROM maintenance.ticket t
        LEFT JOIN maintenance.task_type tt ON tt.community_id = t.community_id AND tt.id = t.task_type_id
        LEFT JOIN property.unit u ON u.community_id = t.community_id AND u.id = t.unit_id
        LEFT JOIN identity.membership a ON a.community_id = t.community_id AND a.id = t.assignee_id
        JOIN identity.membership r ON r.community_id = t.community_id AND r.id = t.raised_by_id
        LEFT JOIN identity.role rr ON rr.community_id = t.community_id AND rr.id = t.raised_by_role_id""";
    static final String FILTER = """
        WHERE (CAST(:status AS text) IS NULL OR t.status = :status)
          AND (CAST(:active AS boolean) IS FALSE OR t.status IN ('Open', 'Assigned', 'In Progress', 'On Hold'))
          AND (CAST(:category AS text) IS NULL OR lower(t.category) = lower(:category))
          AND (CAST(:unit AS uuid) IS NULL OR t.unit_id = CAST(:unit AS uuid) OR CAST(:unit AS uuid) = ANY (t.affected_unit_ids))
          AND (CAST(:raisedBy AS uuid) IS NULL OR t.raised_by_id = CAST(:raisedBy AS uuid))
          AND (CAST(:assignee AS uuid) IS NULL OR t.assignee_id = CAST(:assignee AS uuid))
          AND (CAST(:q AS text) IS NULL OR t.title ILIKE :q ESCAPE '\\' OR t.short_id ILIKE :q ESCAPE '\\')
          AND (CAST(:statuses AS text) IS NULL OR t.status = ANY (string_to_array(CAST(:statuses AS text), ',')))
          AND (CAST(:priorities AS text) IS NULL OR t.priority = ANY (string_to_array(CAST(:priorities AS text), ',')))
          AND (CAST(:taskType AS text) IS NULL OR lower(tt.name) = lower(:taskType))
          AND (CAST(:financial AS boolean) IS NULL OR t.financial = CAST(:financial AS boolean))
          AND (CAST(:scope AS text) IS NULL OR t.scope = :scope)""";
    /** The orders a list may ask for (anything else: newest first). */
    static final Map<String, String> ORDERS = Map.of("created", "t.created_at DESC, t.id", "sla", "t.sla_due_at ASC NULLS FIRST, t.created_at DESC, t.id",
        "status", "t.status, t.created_at DESC, t.id");
    static final String INSERT = """
        INSERT INTO maintenance.ticket (community_id, id, task_type_id, title, description, unit_id, scope, location, category, sub_category, priority, status,
                                        assignee_id, assigned_at, sla_due_at, preferred_time, raised_by_id, raised_by_role_id, custom, asset_id)
        VALUES (CAST(:community AS uuid), CAST(:id AS uuid), CAST(:taskType AS uuid), :title, :description, CAST(:unit AS uuid), :scope, :location, :category, :subCategory,
                :priority, :status, CAST(:assignee AS uuid), CAST(:assignedAt AS timestamptz), CAST(:sla AS date), :preferredTime, CAST(:raisedBy AS uuid),
                (SELECT ro.id FROM identity.role ro WHERE ro.code = CAST(:raisedByRole AS text)), CAST(:custom AS jsonb), CAST(:asset AS uuid))
        RETURNING short_id, version""";
    static final String CLAIM_OVERDUE = """
        WITH late AS (
          SELECT x.id, x.assignee_id, x.sla_due_at, x.status FROM maintenance.ticket x
          WHERE x.status IN ('Open', 'Assigned', 'In Progress', 'On Hold') AND x.sla_due_at < CAST(:today AS date)
            AND NOT EXISTS (SELECT 1 FROM maintenance.ticket_sla_alert a WHERE a.community_id = x.community_id AND a.ticket_id = x.id AND a.due_on = x.sla_due_at)
          ORDER BY x.sla_due_at LIMIT :limit),
        told AS (
          INSERT INTO maintenance.ticket_sla_alert (community_id, ticket_id, due_on)
          SELECT platform.current_community(), late.id, late.sla_due_at FROM late
          ON CONFLICT DO NOTHING RETURNING ticket_id, due_on)
        SELECT late.id, late.assignee_id, late.sla_due_at, late.status FROM late JOIN told ON told.ticket_id = late.id AND told.due_on = late.sla_due_at""";

    static final String UPDATE = """
        UPDATE maintenance.ticket SET title = :title, description = :description, location = :location, category = :category, sub_category = :subCategory,
               priority = :priority, status = :status, assignee_id = CAST(:assignee AS uuid), assigned_at = CAST(:assignedAt AS timestamptz), sla_due_at = CAST(:sla AS date),
               preferred_time = :preferredTime, affected_unit_ids = CAST(:affected AS uuid[]), resident_rating = :rating, awaiting_parts = :awaitingParts,
               materials_cost = :materialsCost, financial = :financial, work_done = CAST(:workDone AS date), started_at = CAST(:startedAt AS timestamptz),
               completed_at = CAST(:completedAt AS timestamptz), closed_at = CAST(:closedAt AS timestamptz), cancelled_at = CAST(:cancelledAt AS timestamptz),
               cancel_reason = :cancelReason, reopen_count = :reopenCount
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";

    public static String listSql(String scopeSql) { return listSql(scopeSql, "created"); }
    /**
     * One page, read through the order's index (newest first: (community_id, created_at)). The total is counted on its own (countSql):
     * a count in the page query (count(*) OVER ()) made every page read every matching ticket - over a second for "All" at 300 a day for three years.
     */
    public static String listSql(String scopeSql, String order) {
        return COLUMNS + "\n" + FROM + "\n" + FILTER + "\n  AND " + scopeSql + "\nORDER BY " + ORDERS.getOrDefault(order == null ? "created" : order, ORDERS.get("created"))
            + " LIMIT :limit OFFSET :offset";
    }
    /**
     * How many tickets the list's filters match. Only what the access rule needs is joined (the task type for residents, the unit for staff
     * limited to blocks): row-level security keeps the planner from dropping an unused join, and the bare count is answered from an index.
     */
    public static String countSql(String scopeSql) {
        String filter = FILTER.replace("(CAST(:taskType AS text) IS NULL OR lower(tt.name) = lower(:taskType))",
            "(CAST(:taskType AS text) IS NULL OR EXISTS (SELECT 1 FROM maintenance.task_type x WHERE x.community_id = t.community_id AND x.id = t.task_type_id AND lower(x.name) = lower(:taskType)))");
        return "SELECT count(*) AS total\nFROM maintenance.ticket t\n" + scopeJoins(scopeSql) + filter + "\n  AND " + scopeSql;
    }
    /** The joins an access rule needs (its SQL names tt. or u.), nothing more. */
    public static String scopeJoins(String scopeSql) {
        return (scopeSql.contains("tt.") ? "LEFT JOIN maintenance.task_type tt ON tt.community_id = t.community_id AND tt.id = t.task_type_id\n" : "")
            + (scopeSql.contains("u.") ? "LEFT JOIN property.unit u ON u.community_id = t.community_id AND u.id = t.unit_id\n" : "");
    }
    public static String getSql(String scopeSql) { return COLUMNS + "\n" + FROM + "\nWHERE t.id = CAST(:id AS uuid) AND " + scopeSql; }

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcTicketRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public Page<Ticket> find(Spec<Ticket> scope, Filter f, PageQuery page) {
        Map<String, Object> p = new HashMap<>(scope.params());
        p.put("status", f.status()); p.put("active", f.activeOnly()); p.put("category", f.category()); p.put("unit", f.unit() == null ? null : f.unit().toString());
        p.put("raisedBy", f.raisedBy() == null ? null : f.raisedBy().toString()); p.put("assignee", f.assignee() == null ? null : f.assignee().toString());
        p.put("q", f.q() == null || f.q().isBlank() ? null : Rows.like(f.q().strip())); p.put("limit", page.limit()); p.put("offset", page.offset());
        p.put("statuses", joined(f.statuses())); p.put("priorities", joined(f.priorities())); p.put("taskType", blank(f.taskType()) ? null : f.taskType());
        p.put("financial", f.financial()); p.put("scope", blank(f.scope()) ? null : f.scope());
        List<Ticket> rows = jdbc.query(listSql(scope.sql(), f.order()), p, (rs, i) -> map(rs));
        // a first page that is not full is the whole list: no need to count
        long total = page.offset() == 0 && rows.size() < page.limit() ? rows.size()
            : java.util.Objects.requireNonNullElse(jdbc.queryForObject(countSql(scope.sql()), p, Long.class), 0L);
        return new Page<>(rows, total, page.limit(), page.offset());
    }
    private static boolean blank(String s) { return s == null || s.isBlank(); }
    private static String joined(List<String> xs) {
        if (xs == null) return null;
        List<String> v = xs.stream().filter((x) -> x != null && !x.isBlank() && !x.contains(",")).map(String::strip).toList();
        return v.isEmpty() ? null : String.join(",", v);
    }
    @Override public Optional<Ticket> findById(UUID id, Spec<Ticket> scope) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString());
        return jdbc.query(getSql(scope.sql()), p, (rs, i) -> map(rs)).stream().findFirst();
    }
    @Override public void insert(Ticket t) {
        Ticket.State s = t.state();
        Map<String, Object> p = new HashMap<>();
        p.put("community", s.community.toString()); p.put("id", s.id.toString()); p.put("taskType", s.taskType == null ? null : s.taskType.id().toString());
        p.put("title", s.title); p.put("description", s.description); p.put("unit", s.unit == null ? null : s.unit.toString()); p.put("scope", s.scope); p.put("location", s.location);
        p.put("category", s.category); p.put("subCategory", s.subCategory); p.put("priority", s.priority); p.put("status", s.status.label());
        p.put("assignee", s.assignee == null ? null : s.assignee.toString()); p.put("assignedAt", Rows.ts(s.assignedAt)); p.put("sla", Rows.sqlDate(s.slaDueAt));
        p.put("preferredTime", s.preferredTime); p.put("raisedBy", s.raisedBy.toString()); p.put("raisedByRole", s.raisedByRole); p.put("custom", write(s.custom)); p.put("asset", s.asset == null ? null : s.asset.toString());
        jdbc.query(INSERT, p, (rs, i) -> { t.numbered(rs.getString("short_id")); t.stored(rs.getLong("version")); s.version = t.version(); return null; });
    }
    static final String SIGN_OFF = """
        UPDATE maintenance.ticket SET ec_approval = :value, ec_approved_by_id = CAST(:by AS uuid), ec_approved_at = CASE WHEN :by IS NULL THEN NULL ELSE now() END
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    @Override public boolean signOff(UUID id, long version, String value, UUID by) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", id.toString()); p.put("version", version); p.put("value", value); p.put("by", by == null ? null : by.toString());
        return !jdbc.query(SIGN_OFF, p, (rs, i) -> rs.getLong("version")).isEmpty();
    }
    @Override public boolean save(Ticket t) {
        Ticket.State s = t.state();
        Map<String, Object> p = new HashMap<>();
        p.put("id", s.id.toString()); p.put("version", t.version()); p.put("title", s.title); p.put("description", s.description); p.put("location", s.location);
        p.put("category", s.category); p.put("subCategory", s.subCategory); p.put("priority", s.priority); p.put("status", s.status.label());
        p.put("assignee", s.assignee == null ? null : s.assignee.toString()); p.put("assignedAt", Rows.ts(s.assignedAt)); p.put("sla", Rows.sqlDate(s.slaDueAt));
        p.put("preferredTime", s.preferredTime); p.put("affected", "{" + String.join(",", s.affectedUnits.stream().map(Object::toString).toList()) + "}");
        p.put("rating", s.residentRating); p.put("awaitingParts", s.awaitingParts); p.put("materialsCost", s.materialsCost == null ? null : s.materialsCost.amount());
        p.put("financial", s.financial); p.put("workDone", Rows.sqlDate(s.workDone)); p.put("startedAt", Rows.ts(s.startedAt)); p.put("completedAt", Rows.ts(s.completedAt));
        p.put("closedAt", Rows.ts(s.closedAt)); p.put("cancelledAt", Rows.ts(s.cancelledAt)); p.put("cancelReason", s.cancelReason); p.put("reopenCount", s.reopenCount);
        List<Long> v = jdbc.query(UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        t.stored(v.get(0)); s.version = v.get(0);
        return true;
    }

    private Ticket map(ResultSet rs) throws SQLException {
        Ticket.State s = new Ticket.State();
        s.id = Rows.uuid(rs, "id"); s.community = new CommunityId(Rows.uuid(rs, "community_id")); s.shortId = rs.getString("short_id"); s.title = rs.getString("title");
        s.description = rs.getString("description"); UUID unit = Rows.uuid(rs, "unit_id"); s.unit = unit == null ? null : new UnitId(unit); s.unitNo = rs.getString("unit_no");
        UUID block = Rows.uuid(rs, "block_id"); s.block = block == null ? null : new BlockId(block); s.scope = rs.getString("scope"); s.location = rs.getString("location");
        s.category = rs.getString("category"); s.subCategory = rs.getString("sub_category"); s.priority = rs.getString("priority"); s.status = TicketStatus.of(rs.getString("status"));
        UUID as = Rows.uuid(rs, "assignee_id"); s.assignee = as == null ? null : new MembershipId(as); s.assigneeName = rs.getString("assignee_name");
        s.slaDueAt = Rows.date(rs, "sla_due_at"); s.preferredTime = rs.getString("preferred_time");
        s.affectedUnits = new java.util.LinkedHashSet<>(Rows.set(rs, "affected_unit_ids", (o) -> new UnitId((UUID) o)));
        java.math.BigDecimal rating = rs.getBigDecimal("resident_rating"); s.residentRating = rating == null ? null : rating.intValue();
        s.raisedBy = new MembershipId(Rows.uuid(rs, "raised_by_id")); s.raisedByName = rs.getString("raised_by_name"); s.raisedByRole = rs.getString("raised_by_role");
        s.awaitingParts = rs.getBoolean("awaiting_parts"); java.math.BigDecimal mc = rs.getBigDecimal("materials_cost"); s.materialsCost = mc == null ? null : new Money(mc);
        s.financial = rs.getBoolean("financial"); s.workDone = Rows.date(rs, "work_done");
        s.assignedAt = Rows.instant(rs, "assigned_at"); s.startedAt = Rows.instant(rs, "started_at"); s.completedAt = Rows.instant(rs, "completed_at");
        s.closedAt = Rows.instant(rs, "closed_at"); s.cancelledAt = Rows.instant(rs, "cancelled_at"); s.cancelReason = rs.getString("cancel_reason"); s.reopenCount = rs.getInt("reopen_count");
        s.asset = rs.getObject("asset_id", UUID.class); s.assetName = rs.getString("asset_name");
        s.ecApprovedBy = rs.getString("ec_approved_by"); s.ecApprovedAt = Rows.instant(rs, "ec_approved_at");
        try { s.custom = json.readValue(rs.getString("custom"), new TypeReference<Map<String, Object>>() {}); } catch (java.io.IOException e) { throw new SQLException(e); }
        s.createdAt = Rows.instant(rs, "created_at"); s.updatedAt = Rows.instant(rs, "updated_at"); s.version = rs.getLong("version");
        s.approval = new Ticket.Approval(rs.getString("quotation_status"), rs.getString("invoice_status"), Rows.money(rs, "approved_amount"), Rows.uuid(rs, "selected_quotation_id"),
            Rows.uuid(rs, "selected_invoice_id"), rs.getString("ec_approval"), rs.getString("treasurer_approval"),
            rs.getString("final_required") == null ? null : rs.getBoolean("final_required"));
        UUID tt = Rows.uuid(rs, "tt_id");
        if (tt != null) s.taskType = new TaskType(tt, rs.getString("tt_name"), rs.getString("tt_icon"), rs.getString("creator_scope"), rs.getString("assignment_mode"),
            rs.getString("quotation_stage"), rs.getString("ec_approval_stage"), rs.getString("treasurer_stage"), rs.getString("invoice_stage"), rs.getString("payment_stage"),
            rs.getBoolean("resident_visible"), rs.getBoolean("resident_default"), rs.getBoolean("tt_active"));
        return new Ticket(s);
    }
    private String write(Object o) { try { return json.writeValueAsString(o); } catch (Exception e) { throw new IllegalStateException(e); } }

    @Override public List<Overdue> claimOverdue(java.time.LocalDate today, int limit) {
        return jdbc.query(CLAIM_OVERDUE, Map.of("today", today.toString(), "limit", limit), (rs, i) -> new Overdue(Rows.uuid(rs, "id"),
            Rows.uuid(rs, "assignee_id") == null ? null : new MembershipId(Rows.uuid(rs, "assignee_id")), Rows.date(rs, "sla_due_at"), rs.getString("status")));
    }
}
