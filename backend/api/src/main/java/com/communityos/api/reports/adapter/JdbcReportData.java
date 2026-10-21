package com.communityos.api.reports.adapter;

import com.communityos.api.reports.application.port.ReportData;
import com.communityos.api.reports.domain.Reports;
import com.communityos.api.shared.jdbc.Rows;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** What the reports read, on the tenant connection (row security applies), and the schedules and sent reports. */
public final class JdbcReportData implements ReportData {
    static final String BOOKINGS = """
        SELECT b.date, b.slot, t.name AS amenity, b.unit_id, u.unit_no, b.status, b.payment_status, b.base_amount, b.gst_amount, b.fee_total
        FROM amenity.booking b
        LEFT JOIN amenity.amenity_type t ON t.community_id = b.community_id AND t.id = b.amenity_type_id
        LEFT JOIN property.unit u ON u.community_id = b.community_id AND u.id = b.unit_id
        WHERE b.date BETWEEN CAST(:from AS date) AND CAST(:to AS date) AND (CAST(:unit AS uuid) IS NULL OR b.unit_id = CAST(:unit AS uuid))
        ORDER BY b.date, b.slot LIMIT 5000""";
    static final String UNPAID = """
        SELECT d.unit_id, u.unit_no, c.name AS category, d.billed_month, d.total - d.paid_amount - d.credit_applied AS outstanding, d.tax_amount, d.due_date
        FROM billing.due d
        JOIN billing.charge_category c ON c.community_id = d.community_id AND c.id = d.category_id
        LEFT JOIN property.unit u ON u.community_id = d.community_id AND u.id = d.unit_id
        WHERE d.status IN ('Unpaid', 'Partly paid') AND d.total - d.paid_amount - d.credit_applied > 0 AND (CAST(:unit AS uuid) IS NULL OR d.unit_id = CAST(:unit AS uuid))
        ORDER BY d.due_date NULLS LAST LIMIT 5000""";
    static final String PAYMENTS = """
        SELECT CAST(timezone(CAST(:tz AS text), p.received_at) AS date) AS paid_on, u.unit_no, p.amount - p.refunded_amount AS amount, p.method,
               coalesce((SELECT string_agg(DISTINCT c.name, ', ') FROM billing.payment_allocation a
                         JOIN billing.due d ON d.community_id = a.community_id AND d.id = a.due_id
                         JOIN billing.charge_category c ON c.community_id = d.community_id AND c.id = d.category_id
                         WHERE a.community_id = p.community_id AND a.payment_id = p.id), initcap(coalesce(p.claimed_type, 'Other'))) AS kinds
        FROM billing.payment p LEFT JOIN property.unit u ON u.community_id = p.community_id AND u.id = p.unit_id
        WHERE p.status IN ('Captured', 'Partly refunded') AND CAST(timezone(CAST(:tz AS text), p.received_at) AS date) BETWEEN CAST(:from AS date) AND CAST(:to AS date)
        ORDER BY p.received_at LIMIT 5000""";
    static final String PLANT = """
        SELECT l.date, l.bh_kl, l.wtp_kl, l.stp_kl, l.salt_used, l.chlorine_used, l.remarks FROM assets.plant_log l
        WHERE l.date BETWEEN CAST(:from AS date) AND CAST(:to AS date) ORDER BY l.date""";
    static final String TASKS = """
        SELECT t.short_id, t.title, t.category, t.priority, t.status, m.display_name AS assignee, t.sla_due_at, t.created_at, coalesce(t.closed_at, t.completed_at, t.cancelled_at) AS closed_at
        FROM maintenance.ticket t LEFT JOIN identity.membership m ON m.community_id = t.community_id AND m.id = t.assignee_id
        WHERE t.status NOT IN ('Completed', 'Closed', 'Cancelled') OR t.created_at > now() - interval '70 days' OR coalesce(t.closed_at, t.completed_at, t.cancelled_at) > now() - interval '70 days'
        ORDER BY t.sla_due_at NULLS LAST, t.created_at LIMIT 5000""";
    static final String AUDITS = "SELECT a.area, a.audit_date, a.result, a.score, a.next_due FROM assets.facility_audit a WHERE a.area IS NOT NULL";
    static final String OPEN_TASK = "SELECT t.short_id FROM maintenance.ticket t WHERE t.community_id = e.community_id AND t.asset_id = e.id AND t.status NOT IN ('Completed', 'Closed', 'Cancelled')";
    static final String INFRA = """
        SELECT e.name, e.type, e.area, CASE WHEN e.status IN ('Needs attention', 'Under repair', 'Out of service') THEN e.status ELSE 'Needs attention' END AS condition, e.quantity, e.faulty,
               (""" + OPEN_TASK + """
         ORDER BY t.created_at LIMIT 1) AS open_task
        FROM assets.equipment e
        WHERE e.status <> 'Retired' AND (e.status IN ('Needs attention', 'Under repair', 'Out of service') OR EXISTS (""" + OPEN_TASK + "))\nORDER BY e.name LIMIT 5000";
    static final String WORK = """
        SELECT w.needed_on, w.event_name, w.title, w.phase, w.staff_requested, w.staff_confirmed, w.staff_type, w.owner_role, w.status FROM maintenance.event_work w
        WHERE w.status IS NULL OR w.status NOT IN ('Done', 'Cancelled') ORDER BY w.needed_on NULLS LAST LIMIT 5000""";
    static final String COMMUNITY = """
        SELECT coalesce((SELECT nullif(f.default_value, '') FROM comms.merge_field f WHERE f.token = '{{SOCIETY_NAME}}' LIMIT 1),
                        (SELECT c.name FROM platform.community c WHERE c.id = platform.current_community())) AS name""";
    static final String SCHEDULE_COLUMNS = """
        SELECT s.id, s.short_id, s.name, s.report_type, s.period, s.format, s.frequency, to_char(s.time, 'HH24:MI') AS time, s.weekday, s.month_day, s.channels, s.audience, s.role_ids,
               s.unit_ids, s.member_ids, s.extra, s.show_cols, s.show_tax, s.show_totals, s.show_summary, s.intro, s.footer, s.skip_empty, s.active, s.last_run_key, s.version
        FROM reports.schedule s""";
    static final String SCHEDULES = SCHEDULE_COLUMNS + "\nWHERE s.active ORDER BY s.name";
    static final String SCHEDULE = SCHEDULE_COLUMNS + "\nWHERE s.id = CAST(:id AS uuid)";
    static final String SCHEDULE_LOCK = SCHEDULE + " FOR UPDATE OF s";
    static final String MARK = "UPDATE reports.schedule SET last_run_key = :key WHERE id = CAST(:id AS uuid)";
    static final String RUN = """
        INSERT INTO reports.run (community_id, id, schedule_id, name, run_at, title, summary, columns, rows, sent_to, report_type, period_from, period_to, delivered, manual)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:schedule AS uuid), :name, now(), :title, :summary, CAST(:columns AS text[]), CAST(:rows AS jsonb), :sentTo, :type,
                CAST(:from AS date), CAST(:to AS date), :delivered, :manual)""";
    static final String ROLE_CODES = "SELECT r.code FROM identity.role r WHERE r.id = ANY (CAST(:ids AS uuid[])) ORDER BY r.code";
    static final String UNITS_WITH_PEOPLE = """
        SELECT u.id, u.unit_no FROM property.unit u
        WHERE u.status = 'Active' AND EXISTS (SELECT 1 FROM property.occupant o JOIN identity.membership m ON m.community_id = o.community_id AND m.person_id = o.person_id AND m.status = 'Active'
                                              WHERE o.community_id = u.community_id AND o.unit_id = u.id AND o.portal_access AND (o.to_date IS NULL OR o.to_date >= current_date))
        ORDER BY u.unit_no""";
    static final String UNITS = "SELECT u.id, u.unit_no FROM property.unit u WHERE u.id = ANY (CAST(:ids AS uuid[])) ORDER BY u.unit_no";
    static final String QUEUE = """
        INSERT INTO comms.outbox_message (community_id, id, created_at, event, channel, to_value, status, subject, body)
        VALUES (platform.current_community(), gen_random_uuid(), now(), 'report', :channel, :to, 'Queued', :subject, :body)""";

    private final NamedParameterJdbcTemplate jdbc; private final String zone;
    public JdbcReportData(NamedParameterJdbcTemplate jdbc, String zone) { this.jdbc = jdbc; this.zone = zone; }

    static Map<String, Object> range(LocalDate from, LocalDate to) { Map<String, Object> p = new HashMap<>(); p.put("from", from.toString()); p.put("to", to.toString()); return p; }
    @Override public List<Reports.BookingRow> bookings(LocalDate from, LocalDate to, UUID unitId) {
        Map<String, Object> p = range(from, to); p.put("unit", s(unitId));
        return jdbc.query(BOOKINGS, p, (rs, i) -> new Reports.BookingRow(Rows.date(rs, "date"), rs.getString("slot"), rs.getString("amenity"), Rows.uuid(rs, "unit_id"), rs.getString("unit_no"),
            rs.getString("status"), rs.getString("payment_status"), rs.getBigDecimal("base_amount"), rs.getBigDecimal("gst_amount"), rs.getBigDecimal("fee_total")));
    }
    @Override public List<Reports.DueRow> unpaidDues(UUID unitId) {
        Map<String, Object> p = new HashMap<>(); p.put("unit", s(unitId));
        return jdbc.query(UNPAID, p, (rs, i) -> new Reports.DueRow(Rows.uuid(rs, "unit_id"), rs.getString("unit_no"), rs.getString("category"), Rows.date(rs, "billed_month"),
            rs.getBigDecimal("outstanding"), rs.getBigDecimal("tax_amount"), Rows.date(rs, "due_date")));
    }
    @Override public List<Reports.PaymentRow> payments(LocalDate from, LocalDate to) {
        Map<String, Object> p = range(from, to); p.put("tz", zone);
        return jdbc.query(PAYMENTS, p, (rs, i) -> new Reports.PaymentRow(Rows.date(rs, "paid_on"), rs.getString("unit_no"), rs.getString("kinds"), rs.getBigDecimal("amount"), rs.getString("method")));
    }
    @Override public List<Reports.PlantRow> plantLogs(LocalDate from, LocalDate to) {
        return jdbc.query(PLANT, range(from, to), (rs, i) -> new Reports.PlantRow(Rows.date(rs, "date"), rs.getBigDecimal("bh_kl"), rs.getBigDecimal("wtp_kl"), rs.getBigDecimal("stp_kl"),
            rs.getBigDecimal("salt_used"), rs.getBigDecimal("chlorine_used"), rs.getString("remarks")));
    }
    @Override public List<Reports.TaskRow> tasks() {
        return jdbc.query(TASKS, Map.of(), (rs, i) -> new Reports.TaskRow(rs.getString("short_id"), rs.getString("title"), rs.getString("category"), rs.getString("priority"), rs.getString("status"),
            rs.getString("assignee"), Rows.instant(rs, "sla_due_at"), Rows.instant(rs, "created_at"), Rows.instant(rs, "closed_at")));
    }
    @Override public List<Reports.AuditRow> audits() {
        return jdbc.query(AUDITS, Map.of(), (rs, i) -> new Reports.AuditRow(rs.getString("area"), Rows.date(rs, "audit_date"), rs.getString("result"), rs.getBigDecimal("score"), Rows.date(rs, "next_due")));
    }
    @Override public List<Reports.InfraRow> infra() {
        return jdbc.query(INFRA, Map.of(), (rs, i) -> {
            int q = rs.getInt("quantity"); boolean nq = rs.wasNull(); int f = rs.getInt("faulty"); boolean nf = rs.wasNull();
            return new Reports.InfraRow(rs.getString("name"), rs.getString("type"), rs.getString("area"), rs.getString("condition"), nq ? null : q, nf ? null : f, rs.getString("open_task"));
        });
    }
    @Override public List<Reports.WorkRow> pendingEventWork() {
        return jdbc.query(WORK, Map.of(), (rs, i) -> new Reports.WorkRow(Rows.date(rs, "needed_on"), rs.getString("event_name"), rs.getString("title"), rs.getString("phase"),
            rs.getBigDecimal("staff_requested"), rs.getBigDecimal("staff_confirmed"), rs.getString("staff_type"), rs.getString("owner_role"), rs.getString("status")));
    }
    @Override public String communityName() { return jdbc.query(COMMUNITY, Map.of(), (rs, i) -> rs.getString("name")).stream().findFirst().orElse(""); }

    @Override public List<Schedule> activeSchedules() { return jdbc.query(SCHEDULES, Map.of(), (rs, i) -> schedule(rs)); }
    @Override public Optional<Schedule> schedule(UUID id, boolean lock) { return jdbc.query(lock ? SCHEDULE_LOCK : SCHEDULE, Map.of("id", id.toString()), (rs, i) -> schedule(rs)).stream().findFirst(); }
    @Override public void markRun(UUID scheduleId, String key) { jdbc.update(MARK, Map.of("id", scheduleId.toString(), "key", key)); }
    @Override public void insertRun(Run r) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", r.id().toString()); p.put("schedule", s(r.scheduleId())); p.put("name", r.name()); p.put("title", r.title()); p.put("summary", r.summary()); p.put("columns", array(r.columns()));
        p.put("rows", r.rowsJson()); p.put("sentTo", r.sentTo()); p.put("type", r.type()); p.put("from", s(r.from())); p.put("to", s(r.to())); p.put("delivered", r.delivered()); p.put("manual", r.manual());
        jdbc.update(RUN, p);
    }
    @Override public List<String> roleCodes(List<UUID> roleIds) { return roleIds.isEmpty() ? List.of() : jdbc.query(ROLE_CODES, Map.of("ids", array(roleIds)), (rs, i) -> rs.getString("code")); }
    @Override public List<UnitRef> unitsWithPeople() { return jdbc.query(UNITS_WITH_PEOPLE, Map.of(), (rs, i) -> new UnitRef(Rows.uuid(rs, "id"), rs.getString("unit_no"))); }
    @Override public List<UnitRef> units(List<UUID> ids) { return ids.isEmpty() ? List.of() : jdbc.query(UNITS, Map.of("ids", array(ids)), (rs, i) -> new UnitRef(Rows.uuid(rs, "id"), rs.getString("unit_no"))); }
    @Override public void queueExtra(String channel, String to, String subject, String body) {
        Map<String, Object> p = new HashMap<>(); p.put("channel", channel); p.put("to", to); p.put("subject", subject); p.put("body", body);
        jdbc.update(QUEUE, p);
    }
    static Schedule schedule(ResultSet rs) throws SQLException {
        String t = rs.getString("time"); int md = rs.getInt("month_day"); boolean noMd = rs.wasNull();
        return new Schedule(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("name"), rs.getString("report_type"), rs.getString("period"), rs.getString("format"), rs.getString("frequency"),
            t == null ? null : LocalTime.parse(t), rs.getString("weekday"), noMd ? null : md, Rows.list(rs, "channels", String::valueOf), rs.getString("audience"),
            Rows.list(rs, "role_ids", (o) -> UUID.fromString(o.toString())), Rows.list(rs, "unit_ids", (o) -> UUID.fromString(o.toString())), Rows.list(rs, "member_ids", (o) -> UUID.fromString(o.toString())),
            rs.getString("extra"), Rows.list(rs, "show_cols", String::valueOf), bool(rs, "show_tax"), bool(rs, "show_totals"), bool(rs, "show_summary"),
            rs.getString("intro"), rs.getString("footer"), rs.getBoolean("skip_empty"), rs.getBoolean("active"), rs.getString("last_run_key"), rs.getLong("version"));
    }
    static Boolean bool(ResultSet rs, String c) throws SQLException { boolean v = rs.getBoolean(c); return rs.wasNull() ? null : v; }
    static String s(Object o) { return o == null ? null : o.toString(); }
    static String array(Collection<?> xs) { return "{" + String.join(",", xs.stream().map((x) -> "\"" + x.toString().replace("\\", "\\\\").replace("\"", "\\\"") + "\"").toList()) + "}"; }
}
