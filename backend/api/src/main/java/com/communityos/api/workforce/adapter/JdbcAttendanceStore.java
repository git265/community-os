package com.communityos.api.workforce.adapter;

import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.workforce.application.port.AttendanceStore;
import com.communityos.api.workforce.domain.Attendance;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Attendance on the tenant connection. */
public final class JdbcAttendanceStore implements AttendanceStore {
    static final String SETTINGS = """
        SELECT s.site_name, s.site_lat, s.site_lng, s.radius_m, s.enforcement, s.grace_minutes, s.shift_starts::text AS shift_starts, s.max_shift_hours
        FROM workforce.attendance_setting s LIMIT 1""";
    static final String COLUMNS = """
        SELECT a.id, a.short_id, a.member_id, a.staff_name, a.role_name, a.date, a.clock_in, a.clock_out, a.note, a.in_lat, a.in_lng, a.in_acc, a.in_site, a.in_dist, a.out_lat, a.out_lng,
               a.out_acc, a.out_site, a.out_dist, a.hours, a.source, a.shift_type, a.late_min, a.corrected_by_id, a.correction_note, a.created_at, a.version
        FROM workforce.attendance_session a""";
    static final String OPEN = COLUMNS + "\nWHERE a.member_id = CAST(:member AS uuid) AND a.clock_out IS NULL FOR UPDATE OF a";
    static final String OVERDUE = COLUMNS + """

        WHERE a.clock_out IS NULL
          AND a.clock_in < now() - make_interval(mins => CAST(coalesce((SELECT s.max_shift_hours FROM workforce.attendance_setting s LIMIT 1), 12) * 60 AS integer))
        ORDER BY a.clock_in LIMIT 200 FOR UPDATE OF a SKIP LOCKED""";
    static final String ONE = COLUMNS + "\nWHERE a.id = CAST(:id AS uuid)";
    static final String ONE_LOCK = ONE + " FOR UPDATE OF a";
    static final String LIST = COLUMNS + """

        WHERE (CAST(:from AS date) IS NULL OR a.date >= CAST(:from AS date)) AND (CAST(:to AS date) IS NULL OR a.date <= CAST(:to AS date))
          AND (CAST(:member AS uuid) IS NULL OR a.member_id = CAST(:member AS uuid))
        ORDER BY a.clock_in DESC LIMIT 5000""";
    static final String GATE_STAYS = """
        SELECT v.member_id, v.name, v.in_at, v.out_at FROM gate.visit v
        WHERE v.member_id IS NOT NULL AND v.in_at IS NOT NULL AND v.state IN ('Inside', 'Exited', 'Auto-closed')
          AND (CAST(:from AS date) IS NULL OR v.in_at >= CAST(:from AS date)::timestamp AT TIME ZONE :zone)
          AND (CAST(:to AS date) IS NULL OR v.in_at < (CAST(:to AS date) + 1)::timestamp AT TIME ZONE :zone)
          AND (CAST(:member AS uuid) IS NULL OR v.member_id = CAST(:member AS uuid))
        ORDER BY v.in_at LIMIT 10000""";
    static final String INSERT = """
        INSERT INTO workforce.attendance_session (community_id, id, member_id, staff_name, role_name, date, clock_in, note, in_lat, in_lng, in_acc, in_site, in_dist, source, shift_type, late_min)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:member AS uuid), :name, :role, CAST(:date AS date), CAST(:clockIn AS timestamptz), :note, :lat, :lng, :acc, :site, :dist,
                :source, :shift, :late)
        RETURNING short_id, version, created_at""";
    static final String UPDATE = """
        UPDATE workforce.attendance_session SET date = CAST(:date AS date), clock_in = CAST(:clockIn AS timestamptz), clock_out = CAST(:clockOut AS timestamptz), note = :note,
               out_lat = :lat, out_lng = :lng, out_acc = :acc, out_site = :site, out_dist = :dist, hours = :hours, source = :source, corrected_by_id = CAST(:correctedBy AS uuid),
               correction_note = :correction
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String DELETE = "DELETE FROM workforce.attendance_session WHERE id = CAST(:id AS uuid) AND version = :version";
    static final String SHIFT_OF = """
        SELECT coalesce((SELECT s.shift_type FROM workforce.shift s WHERE s.community_id = f.community_id AND s.staff_id = f.id AND s.date = CAST(:date AS date)), f.shift) AS shift
        FROM maintenance.field_staff f WHERE f.membership_id = CAST(:member AS uuid) LIMIT 1""";
    static final String ON_DUTY = "UPDATE maintenance.field_staff SET clocked_in = :on WHERE membership_id = CAST(:member AS uuid) AND clocked_in <> :on";
    static final String ROLE = """
        SELECT r.name FROM identity.membership_role mr JOIN identity.role r ON r.id = mr.role_id
        WHERE mr.membership_id = CAST(:member AS uuid) ORDER BY mr.is_primary DESC LIMIT 1""";
    static final String TEAMS = """
        SELECT coalesce(f.trade, 'Other') AS team, count(*) FILTER (WHERE f.clocked_in) AS on_duty, count(*) AS total
        FROM maintenance.field_staff f GROUP BY 1 ORDER BY 1""";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcAttendanceStore(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public Attendance.Settings settings() {
        return jdbc.query(SETTINGS, Map.of(), (rs, i) -> {
            Map<String, String> starts;
            try { starts = json.readValue(rs.getString("shift_starts"), new TypeReference<Map<String, String>>() {}); }
            catch (com.fasterxml.jackson.core.JsonProcessingException e) { starts = Map.of(); }
            int radius = rs.getInt("radius_m"); boolean noRadius = rs.wasNull(); int grace = rs.getInt("grace_minutes"); boolean noGrace = rs.wasNull();
            return new Attendance.Settings(rs.getString("site_name"), rs.getBigDecimal("site_lat"), rs.getBigDecimal("site_lng"), noRadius ? 300 : radius, rs.getString("enforcement"),
                noGrace ? 15 : grace, starts, rs.getBigDecimal("max_shift_hours"));
        }).stream().findFirst().orElse(new Attendance.Settings(null, null, null, 300, Attendance.RECORD, 15, Map.of(), BigDecimal.valueOf(12)));
    }
    @Override public Optional<Attendance.Session> openSession(UUID memberId) { return jdbc.query(OPEN, Map.of("member", memberId.toString()), (rs, i) -> session(rs)).stream().findFirst(); }
    @Override public List<Attendance.Session> overdue() { return jdbc.query(OVERDUE, Map.of(), (rs, i) -> session(rs)); }
    @Override public Optional<Attendance.Session> session(UUID id, boolean lock) { return jdbc.query(lock ? ONE_LOCK : ONE, Map.of("id", id.toString()), (rs, i) -> session(rs)).stream().findFirst(); }
    @Override public List<Attendance.Session> sessions(LocalDate from, LocalDate to, UUID memberId) {
        Map<String, Object> p = new HashMap<>(); p.put("from", s(from)); p.put("to", s(to)); p.put("member", s(memberId));
        return jdbc.query(LIST, p, (rs, i) -> session(rs));
    }
    @Override public List<Attendance.GateStay> gateStays(LocalDate from, LocalDate to, UUID memberId, java.time.ZoneId zone) {
        Map<String, Object> p = new HashMap<>(); p.put("from", s(from)); p.put("to", s(to)); p.put("member", s(memberId)); p.put("zone", zone.getId());
        return jdbc.query(GATE_STAYS, p, (rs, i) -> new Attendance.GateStay(Rows.uuid(rs, "member_id"), rs.getString("name"), Rows.instant(rs, "in_at"), Rows.instant(rs, "out_at")));
    }
    @Override public void insert(Attendance.Session x) {
        if (x.id == null) x.id = UUID.randomUUID();
        Map<String, Object> p = new HashMap<>();
        p.put("id", x.id.toString()); p.put("member", x.memberId.toString()); p.put("name", x.staffName); p.put("role", x.roleName); p.put("date", x.date.toString()); p.put("clockIn", x.clockIn.toString());
        p.put("note", x.note); p.put("lat", x.in.lat()); p.put("lng", x.in.lng()); p.put("acc", x.in.acc()); p.put("site", x.in.site()); p.put("dist", x.in.dist()); p.put("source", x.source);
        p.put("shift", x.shiftType); p.put("late", x.lateMin);
        jdbc.query(INSERT, p, (rs, i) -> { x.shortId = rs.getString("short_id"); x.version = rs.getLong("version"); x.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Attendance.Session x) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", x.id.toString()); p.put("version", x.version); p.put("date", x.date.toString()); p.put("clockIn", x.clockIn.toString()); p.put("clockOut", s(x.clockOut)); p.put("note", x.note);
        p.put("lat", x.out.lat()); p.put("lng", x.out.lng()); p.put("acc", x.out.acc()); p.put("site", x.out.site()); p.put("dist", x.out.dist()); p.put("hours", x.hours); p.put("source", x.source);
        p.put("correctedBy", s(x.correctedById)); p.put("correction", x.correctionNote);
        List<Long> v = jdbc.query(UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        x.version = v.get(0); return true;
    }
    @Override public boolean delete(UUID id, long version) { return jdbc.update(DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    @Override public String shiftOf(UUID memberId, LocalDate date) {
        return jdbc.query(SHIFT_OF, Map.of("member", memberId.toString(), "date", date.toString()), (rs, i) -> rs.getString("shift")).stream().filter(java.util.Objects::nonNull).findFirst().orElse(null);
    }
    @Override public void onDuty(UUID memberId, boolean on) { jdbc.update(ON_DUTY, Map.of("member", memberId.toString(), "on", on)); }
    @Override public String roleName(UUID memberId) { return jdbc.query(ROLE, Map.of("member", memberId.toString()), (rs, i) -> rs.getString("name")).stream().findFirst().orElse(null); }
    @Override public List<Team> teams() { return jdbc.query(TEAMS, Map.of(), (rs, i) -> new Team(rs.getString("team"), rs.getInt("on_duty"), rs.getInt("total"))); }

    static Attendance.Session session(ResultSet rs) throws SQLException {
        Attendance.Session x = new Attendance.Session();
        x.id = Rows.uuid(rs, "id"); x.shortId = rs.getString("short_id"); x.memberId = Rows.uuid(rs, "member_id"); x.staffName = rs.getString("staff_name"); x.roleName = rs.getString("role_name");
        x.date = Rows.date(rs, "date"); x.clockIn = Rows.instant(rs, "clock_in"); x.clockOut = Rows.instant(rs, "clock_out"); x.note = rs.getString("note");
        x.in = new Attendance.Fix(rs.getBigDecimal("in_lat"), rs.getBigDecimal("in_lng"), rs.getBigDecimal("in_acc"), rs.getString("in_site"), rs.getBigDecimal("in_dist"));
        x.out = new Attendance.Fix(rs.getBigDecimal("out_lat"), rs.getBigDecimal("out_lng"), rs.getBigDecimal("out_acc"), rs.getString("out_site"), rs.getBigDecimal("out_dist"));
        x.hours = rs.getBigDecimal("hours"); x.source = rs.getString("source"); x.shiftType = rs.getString("shift_type"); int late = rs.getInt("late_min"); x.lateMin = rs.wasNull() ? null : late;
        x.correctedById = Rows.uuid(rs, "corrected_by_id"); x.correctionNote = rs.getString("correction_note"); x.createdAt = Rows.instant(rs, "created_at"); x.version = rs.getLong("version");
        return x;
    }
    static String s(Object o) { return o == null ? null : o.toString(); }
}
