package com.communityos.api.gate.adapter;

import com.communityos.api.gate.application.port.GateDirectory;
import com.communityos.api.gate.domain.Gate;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** What the gate rules read from the gate registers (tenant connection). */
public final class JdbcGateDirectory implements GateDirectory {
    static final String SETTINGS = """
        SELECT s.wait_seconds, s.fallback, s.grace_seconds, s.overstay_grace_minutes, s.auto_close_hours, s.quiet_from::text AS quiet_from, s.quiet_to::text AS quiet_to, s.quiet_fallback,
               s.goods_extra_people, s.patrol_min_seconds, s.durations::text AS durations, s.approved_companies
        FROM gate.setting s ORDER BY s.created_at LIMIT 1""";
    static final String UNIT_RULE = "SELECT r.unit_id, r.delivery_mode, r.companies, r.expecting_until, r.away_mode, r.fallback FROM gate.unit_rule r WHERE r.unit_id = CAST(:unit AS uuid)";
    static final String ALLOW_COMPANY = """
        INSERT INTO gate.unit_rule (community_id, unit_id, delivery_mode, companies, fallback)
        VALUES (platform.current_community(), CAST(:unit AS uuid), 'Allow listed', ARRAY[CAST(:company AS text)], 'Community default')
        ON CONFLICT (community_id, unit_id) DO UPDATE SET companies = (SELECT array_agg(DISTINCT c) FROM unnest(gate.unit_rule.companies || ARRAY[CAST(:company AS text)]) c),
               delivery_mode = CASE WHEN gate.unit_rule.delivery_mode = 'Ask me each time' THEN 'Allow listed' ELSE gate.unit_rule.delivery_mode END""";
    static final String PERSON = """
        SELECT p.id, p.name, p.person_class, p.phone, p.photo, p.status, p.vendor, p.delivery_company, p.licence_expiry, p.police_expiry, p.vehicle_no, p.status_reason
        FROM gate.person p WHERE p.id = CAST(:id AS uuid)""";
    static final String STAFF = """
        SELECT m.id, m.display_name, m.status, r.name AS role_name, coalesce(bool_or(g.category = 'Staff'), false) AS staff
        FROM identity.membership m
        LEFT JOIN identity.membership_role mr ON mr.community_id = m.community_id AND mr.membership_id = m.id
        LEFT JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id AND mr.is_primary
        LEFT JOIN identity.role rr ON rr.community_id = mr.community_id AND rr.id = mr.role_id
        LEFT JOIN identity.role_group g ON g.community_id = rr.community_id AND g.id = rr.group_id
        WHERE m.id = CAST(:id AS uuid) GROUP BY m.id, m.display_name, m.status, r.name""";
    static final String LINKS = """
        SELECT l.person_id, l.unit_id, u.unit_no, l.days, l.from_time::text AS from_time, l.to_time::text AS to_time, l.status
        FROM gate.household_link l JOIN property.unit u ON u.community_id = l.community_id AND u.id = l.unit_id WHERE l.person_id = CAST(:person AS uuid)""";
    static final String WORK_ORDERS = "SELECT w.id, w.title, w.vendor, w.days, w.from_time::text AS from_time, w.to_time::text AS to_time, w.roster_ids, w.status FROM gate.work_order w WHERE w.status = 'Active'";
    static final String UNIT = "SELECT u.id, u.unit_no, u.block_id FROM property.unit u WHERE u.id = CAST(:id AS uuid)";
    static final String CHECKPOINT = "SELECT c.id, c.name, c.code, c.active FROM gate.checkpoint c WHERE c.id = CAST(:id AS uuid)";
    static final String ROUNDS = "SELECT r.id, r.name, r.time::text AS time, r.window_min, r.checkpoint_ids, r.days, r.active FROM gate.round r";
    static final String BEAT = """
        INSERT INTO gate.console_pulse (community_id, guard_id, last_at, kind) VALUES (platform.current_community(), CAST(:guard AS uuid), now(), :kind)
        ON CONFLICT (community_id, guard_id) DO UPDATE SET last_at = now(), kind = :kind""";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcGateDirectory(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public Gate.Settings settings() {
        List<Gate.Settings> s = jdbc.query(SETTINGS, Map.of(), (rs, i) -> {
            Map<String, Integer> d;
            try { d = json.readValue(rs.getString("durations") == null ? "{}" : rs.getString("durations"), new TypeReference<Map<String, Integer>>() {}); } catch (java.io.IOException e) { d = Map.of(); }
            return new Gate.Settings(n(rs, "wait_seconds", 60), or(rs.getString("fallback"), "Hold at gate"), n(rs, "grace_seconds", 30), n(rs, "overstay_grace_minutes", 10),
                n(rs, "auto_close_hours", 2), t(rs, "quiet_from"), t(rs, "quiet_to"), or(rs.getString("quiet_fallback"), "Hold at gate"), or(rs.getString("goods_extra_people"), "Block until the guard confirms"),
                n(rs, "patrol_min_seconds", 20), d, Rows.list(rs, "approved_companies", String::valueOf));
        });
        return s.isEmpty() ? new Gate.Settings(60, "Hold at gate", 30, 10, 2, null, null, "Hold at gate", "Block until the guard confirms", 20, Map.of(), List.of()) : s.get(0);
    }
    @Override public Optional<Gate.Staff> staff(UUID memberId) {
        return jdbc.query(STAFF, Map.of("id", memberId.toString()), (rs, i) -> new Gate.Staff(Rows.uuid(rs, "id"), rs.getString("display_name"), rs.getString("role_name"),
            "Active".equals(rs.getString("status")), rs.getBoolean("staff"))).stream().findFirst();
    }
    @Override public Gate.UnitRule unitRule(UnitId unit) {
        return jdbc.query(UNIT_RULE, Map.of("unit", unit.toString()), (rs, i) -> new Gate.UnitRule(unit, rs.getString("delivery_mode"), Rows.list(rs, "companies", String::valueOf),
            Rows.instant(rs, "expecting_until"), rs.getBoolean("away_mode"), rs.getString("fallback"))).stream().findFirst().orElse(Gate.UnitRule.defaults(unit));
    }
    @Override public void allowCompany(UnitId unit, String company) { jdbc.update(ALLOW_COMPANY, Map.of("unit", unit.toString(), "company", company)); }
    @Override public Optional<Gate.Person> person(UUID id) {
        return jdbc.query(PERSON, Map.of("id", id.toString()), (rs, i) -> new Gate.Person(Rows.uuid(rs, "id"), rs.getString("name"), rs.getString("person_class"), rs.getString("phone"),
            rs.getString("photo"), rs.getString("status"), rs.getString("vendor"), rs.getString("delivery_company"), Rows.date(rs, "licence_expiry"), Rows.date(rs, "police_expiry"),
            rs.getString("vehicle_no"), rs.getString("status_reason"))).stream().findFirst();
    }
    @Override public List<Gate.Link> links(UUID person) {
        return jdbc.query(LINKS, Map.of("person", person.toString()), (rs, i) -> new Gate.Link(Rows.uuid(rs, "person_id"), new UnitId(Rows.uuid(rs, "unit_id")), rs.getString("unit_no"),
            Rows.list(rs, "days", String::valueOf), t(rs, "from_time"), t(rs, "to_time"), rs.getString("status")));
    }
    @Override public List<Gate.WorkOrder> activeWorkOrders() {
        return jdbc.query(WORK_ORDERS, Map.of(), (rs, i) -> new Gate.WorkOrder(Rows.uuid(rs, "id"), rs.getString("title"), rs.getString("vendor"), Rows.list(rs, "days", String::valueOf),
            t(rs, "from_time"), t(rs, "to_time"), Rows.list(rs, "roster_ids", (o) -> o instanceof UUID u ? u : UUID.fromString(o.toString())), rs.getString("status")));
    }
    @Override public Optional<UnitRef> unit(UnitId unit) {
        return jdbc.query(UNIT, Map.of("id", unit.toString()), (rs, i) -> { UUID b = Rows.uuid(rs, "block_id"); return new UnitRef(unit, rs.getString("unit_no"), b == null ? null : new BlockId(b)); }).stream().findFirst();
    }
    @Override public Optional<Checkpoint> checkpoint(UUID id) {
        return jdbc.query(CHECKPOINT, Map.of("id", id.toString()), (rs, i) -> new Checkpoint(Rows.uuid(rs, "id"), rs.getString("name"), rs.getString("code"), rs.getBoolean("active"))).stream().findFirst();
    }
    @Override public List<Round> rounds() {
        return jdbc.query(ROUNDS, Map.of(), (rs, i) -> new Round(Rows.uuid(rs, "id"), rs.getString("name"), t(rs, "time"), n(rs, "window_min", 60),
            Rows.list(rs, "checkpoint_ids", (o) -> o instanceof UUID u ? u : UUID.fromString(o.toString())), Rows.list(rs, "days", String::valueOf), rs.getBoolean("active")));
    }
    @Override public void beat(UUID guard, String kind) { jdbc.update(BEAT, Map.of("guard", guard.toString(), "kind", kind)); }

    static int n(ResultSet rs, String c, int d) throws SQLException { BigDecimal b = rs.getBigDecimal(c); return b == null ? d : b.intValue(); }
    static LocalTime t(ResultSet rs, String c) throws SQLException { String s = rs.getString(c); return s == null ? null : LocalTime.parse(s); }
    static String or(String s, String d) { return s == null || s.isBlank() ? d : s; }
}
