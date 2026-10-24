package com.communityos.api.gate.adapter;

import com.communityos.api.gate.application.port.GateStore;
import com.communityos.api.gate.domain.Gate;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The gate's records on the tenant connection. Visits and scans are partitioned by month; they are found by id through a per-partition index. */
public final class JdbcGateStore implements GateStore {
    // ---- passes ------------------------------------------------------------------------------------------------------------------------------
    static final String PASS_COLUMNS = """
        SELECT p.id, p.short_id, p.visitor_name, p.phone, p.unit_id, u.unit_no, p.type, p.valid_from, p.valid_to, p.from_time::text AS from_time, p.to_time::text AS to_time,
               p.days, p.vehicle, p.guest_cap, p.goods_kind, p.people_count, p.material, p.carrying_out, p.out_items, p.used_count, p.code, p.photo, p.host_name, p.status,
               p.created_by_id, p.created_at, p.version
        FROM gate.pass p LEFT JOIN property.unit u ON u.community_id = p.community_id AND u.id = p.unit_id""";
    static final String PASSES_MATCHING = PASS_COLUMNS + "\nWHERE p.status <> 'Cancelled' AND (p.code = :q OR p.visitor_name ILIKE :like ESCAPE '\\' OR p.phone LIKE :like ESCAPE '\\') ORDER BY p.created_at DESC LIMIT 50";
    static final String CODE_IN_USE = "SELECT count(*) FROM gate.pass p WHERE p.code = :code AND p.status = 'Active'";
    static final String PASS_INSERT = """
        INSERT INTO gate.pass (community_id, id, visitor_name, phone, unit_id, type, valid_from, valid_to, from_time, to_time, days, vehicle, guest_cap, goods_kind, people_count,
                               material, carrying_out, out_items, used_count, code, photo, host_name, status, created_by_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), :name, :phone, CAST(:unit AS uuid), :type, CAST(:from AS date), CAST(:to AS date), CAST(:fromTime AS time),
                CAST(:toTime AS time), CAST(:days AS text[]), :vehicle, :guestCap, :goodsKind, :people, :material, :carryingOut, :outItems, :used, :code, :photo, :host, :status,
                CAST(:createdBy AS uuid))
        RETURNING short_id, version, created_at""";
    static final String PASS_UPDATE = "UPDATE gate.pass SET used_count = :used, status = :status WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version";
    public static String passesSql(String scope) { return PASS_COLUMNS + "\nWHERE (" + scope + ") AND (CAST(:status AS text) IS NULL OR p.status = :status) ORDER BY p.created_at DESC LIMIT 1000"; }
    public static String passSql(String scope) { return PASS_COLUMNS + "\nWHERE p.id = CAST(:id AS uuid) AND (" + scope + ")"; }

    // ---- visits ------------------------------------------------------------------------------------------------------------------------------
    static final String VISIT_COLUMNS = """
        SELECT v.id, v.short_id, v.name, v.kind, v.unit_id, u.unit_no, v.gate, v.company, v.vehicle, v.phone, v.purpose, v.state, v.method, v.in_at, v.out_at, v.expected_until,
               v.photo, v.person_id, v.member_id, v.pass_id, v.work_order_id, v.approval_id, v.note, v.headcount_expected, v.headcount_in, v.headcount_out, v.material, v.carrying_out,
               v.out_items, v.open_reason, v.out_method, v.verified_by_id, m.display_name AS verified_by_name, v.created_at, v.version
        FROM gate.visit v LEFT JOIN property.unit u ON u.community_id = v.community_id AND u.id = v.unit_id
        LEFT JOIN identity.membership m ON m.community_id = v.community_id AND m.id = v.verified_by_id""";
    static final String VISIT_FILTER = """
          AND (CAST(:state AS text) IS NULL OR v.state = :state) AND (CAST(:unit AS uuid) IS NULL OR v.unit_id = CAST(:unit AS uuid))
          AND (CAST(:from AS date) IS NULL OR v.created_at >= CAST(:from AS date)) AND (CAST(:to AS date) IS NULL OR v.created_at < CAST(:to AS date) + 1)
          AND (CAST(:open AS boolean) IS FALSE OR v.state IN ('Inside', 'Awaiting approval', 'Approved', 'No answer'))""";
    static final String INSIDE_BY_PERSON = VISIT_COLUMNS + "\nWHERE v.person_id = CAST(:person AS uuid) AND v.state = 'Inside' LIMIT 1";
    static final String INSIDE_BY_MEMBER = VISIT_COLUMNS + "\nWHERE v.member_id = CAST(:member AS uuid) AND v.state = 'Inside' LIMIT 1";
    static final String INSIDE_BY_PASS = VISIT_COLUMNS + "\nWHERE v.pass_id = CAST(:pass AS uuid) AND v.state = 'Inside' LIMIT 1";
    static final String INSIDE_BY_PLATE = VISIT_COLUMNS + "\nWHERE v.kind = 'Resident vehicle' AND v.state = 'Inside' AND upper(regexp_replace(v.vehicle, '\\s', '', 'g')) = :plate ORDER BY v.in_at DESC LIMIT 1";
    static final String OVERDUE = VISIT_COLUMNS + "\nWHERE v.state = 'Inside' AND v.expected_until < CAST(:before AS timestamptz) ORDER BY v.expected_until LIMIT 500";
    static final String VISIT_INSERT = """
        INSERT INTO gate.visit (community_id, id, name, kind, unit_id, gate, company, vehicle, phone, purpose, state, method, in_at, out_at, expected_until, photo, person_id, member_id, pass_id,
                                work_order_id, approval_id, note, headcount_expected, headcount_in, headcount_out, material, carrying_out, out_items, open_reason, out_method, verified_by_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), :name, :kind, CAST(:unit AS uuid), :gate, :company, :vehicle, :phone, :purpose, :state, :method,
                CAST(:inAt AS timestamptz), CAST(:outAt AS timestamptz), CAST(:expected AS timestamptz), :photo, CAST(:person AS uuid), CAST(:member AS uuid), CAST(:pass AS uuid), CAST(:workOrder AS uuid),
                CAST(:approval AS uuid), :note, :hcExpected, :hcIn, :hcOut, :material, :carryingOut, :outItems, :openReason, :outMethod, CAST(:verifiedBy AS uuid))
        RETURNING short_id, version, created_at""";
    static final String VISIT_UPDATE = """
        UPDATE gate.visit SET state = :state, method = :method, in_at = CAST(:inAt AS timestamptz), out_at = CAST(:outAt AS timestamptz), expected_until = CAST(:expected AS timestamptz),
               note = :note, headcount_out = :hcOut, open_reason = :openReason, out_method = :outMethod
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    public static String visitsSql(String scope) { return VISIT_COLUMNS + "\nWHERE (" + scope + ")" + VISIT_FILTER + "\nORDER BY v.created_at DESC LIMIT 2000"; }
    public static String visitSql(String scope) { return VISIT_COLUMNS + "\nWHERE v.id = CAST(:id AS uuid) AND (" + scope + ")"; }

    // ---- approvals ---------------------------------------------------------------------------------------------------------------------------
    static final String APPROVAL_COLUMNS = """
        SELECT a.id, a.short_id, a.name, a.unit_id, u.unit_no, a.company, a.purpose, a.vehicle, a.gate, a.photo, a.visit_id, a.kind, a.status, a.requested_at, a.expires_at,
               a.fallback, a.answered_at, a.answered_by_id, m.display_name AS answered_by_name, a.always_allow, a.version
        FROM gate.approval a LEFT JOIN property.unit u ON u.community_id = a.community_id AND u.id = a.unit_id
        LEFT JOIN identity.membership m ON m.community_id = a.community_id AND m.id = a.answered_by_id""";
    static final String EXPIRED = APPROVAL_COLUMNS + "\nWHERE a.status = 'Pending' AND a.expires_at < CAST(:now AS timestamptz) ORDER BY a.expires_at LIMIT 500 FOR UPDATE OF a SKIP LOCKED";
    static final String APPROVAL_INSERT = """
        INSERT INTO gate.approval (community_id, id, name, unit_id, company, purpose, vehicle, gate, photo, visit_id, kind, status, requested_at, expires_at, fallback)
        VALUES (platform.current_community(), CAST(:id AS uuid), :name, CAST(:unit AS uuid), :company, :purpose, :vehicle, :gate, :photo, CAST(:visit AS uuid), :kind, :status,
                CAST(:requestedAt AS timestamptz), CAST(:expiresAt AS timestamptz), :fallback)
        RETURNING short_id, version""";
    static final String APPROVAL_UPDATE = """
        UPDATE gate.approval SET status = :status, answered_at = CAST(:answeredAt AS timestamptz), answered_by_id = CAST(:answeredBy AS uuid), always_allow = :always
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    public static String approvalsSql(String scope) { return APPROVAL_COLUMNS + "\nWHERE (" + scope + ") AND (CAST(:status AS text) IS NULL OR a.status = :status) ORDER BY a.requested_at DESC LIMIT 1000"; }
    public static String approvalSql(String scope) { return APPROVAL_COLUMNS + "\nWHERE a.id = CAST(:id AS uuid) AND (" + scope + ")"; }

    // ---- flags, scans ------------------------------------------------------------------------------------------------------------------------
    static final String FLAG_COLUMNS = """
        SELECT f.id, f.short_id, f.type, f.state, f.gate, f.person_name, f.unit_id, f.detail, f.raised_at, f.grace_until, f.visit_id, f.person_id, f.photo, f.resolution,
               f.resolution_note, f.resolved_by_id, m.display_name AS resolved_by_name, f.resolved_at, f.round_id, f.day, f.version
        FROM gate.flag f LEFT JOIN identity.membership m ON m.community_id = f.community_id AND m.id = f.resolved_by_id""";
    static final String FLAGS = FLAG_COLUMNS + "\nWHERE (CAST(:open AS boolean) IS FALSE OR f.state <> 'Closed') ORDER BY f.raised_at DESC LIMIT 1000";
    static final String FLAG = FLAG_COLUMNS + "\nWHERE f.id = CAST(:id AS uuid)";
    static final String HAS_FLAG = "SELECT count(*) FROM gate.flag f WHERE f.type = :type AND f.visit_id = CAST(:visit AS uuid)";
    static final String OPEN_REPORTS = FLAG_COLUMNS + "\nWHERE f.type = 'Reported person' AND f.person_id = CAST(:person AS uuid) AND f.visit_id IS NULL AND f.state <> 'Closed' ORDER BY f.raised_at DESC";
    static final String OPEN_FLAG_SINCE = "SELECT count(*) FROM gate.flag f WHERE f.type = :type AND f.person_name = :name AND f.state <> 'Closed' AND f.raised_at >= CAST(:since AS timestamptz)";
    static final String HAS_ROUND_FLAG = "SELECT count(*) FROM gate.flag f WHERE f.type = 'Missed patrol' AND f.round_id = CAST(:round AS uuid) AND f.day = CAST(:day AS date)";
    static final String FLAG_INSERT = """
        INSERT INTO gate.flag (community_id, id, type, state, gate, person_name, unit_id, detail, raised_at, grace_until, visit_id, person_id, photo, round_id, day)
        VALUES (platform.current_community(), CAST(:id AS uuid), :type, :state, :gate, :personName, CAST(:unit AS uuid), :detail, CAST(:raisedAt AS timestamptz),
                CAST(:graceUntil AS timestamptz), CAST(:visit AS uuid), CAST(:person AS uuid), :photo, CAST(:round AS uuid), CAST(:day AS date))
        ON CONFLICT DO NOTHING RETURNING short_id, version""";
    static final String FLAG_UPDATE = """
        UPDATE gate.flag SET state = :state, resolution = :resolution, resolution_note = :note, resolved_by_id = CAST(:resolvedBy AS uuid), resolved_at = CAST(:resolvedAt AS timestamptz)
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String LAST_SCAN = "SELECT s.checkpoint_id, s.checkpoint_name, s.guard_id, s.guard, s.at, s.round_id, s.round_name, s.day, s.note, s.lat, s.lng, s.acc_m, s.dist_m, s.place, s.method FROM gate.scan s WHERE s.guard_id = CAST(:guard AS uuid) ORDER BY s.at DESC LIMIT 1";
    static final String SCANS = "SELECT s.checkpoint_id, s.checkpoint_name, s.guard_id, s.guard, s.at, s.round_id, s.round_name, s.day, s.note, s.lat, s.lng, s.acc_m, s.dist_m, s.place, s.method FROM gate.scan s WHERE s.round_id = CAST(:round AS uuid) AND s.day = CAST(:day AS date)";
    static final String SCANS_SINCE = "SELECT s.checkpoint_id, s.checkpoint_name, s.guard_id, s.guard, s.at, s.round_id, s.round_name, s.day, s.note, s.lat, s.lng, s.acc_m, s.dist_m, s.place, s.method FROM gate.scan s WHERE s.day >= CAST(:day AS date) ORDER BY s.at DESC LIMIT 2000";
    static final String SCAN_INSERT = """
        INSERT INTO gate.scan (community_id, checkpoint_id, checkpoint_name, guard_id, guard, at, round_id, round_name, day, note, lat, lng, acc_m, dist_m, place, method)
        VALUES (platform.current_community(), CAST(:cp AS uuid), :cpName, CAST(:guard AS uuid), :guardName, CAST(:at AS timestamptz), CAST(:round AS uuid), :roundName, CAST(:day AS date), :note,
                CAST(:lat AS numeric), CAST(:lng AS numeric), CAST(:acc AS integer), CAST(:dist AS integer), :place, coalesce(:method, 'QR'))""";

    // ---- staff badges ------------------------------------------------------------------------------------------------------------------------
    static final String BADGE_KEY_MAKE = "INSERT INTO gate.badge_key (community_id) VALUES (platform.current_community()) ON CONFLICT (community_id) DO NOTHING";
    static final String BADGE_KEY = "SELECT k.secret FROM gate.badge_key k";
    /** Locks the member's row: a window newer than the last one used is accepted (one row comes back), the same or an older one is not. */
    static final String BADGE_USE = """
        INSERT INTO gate.badge_use (community_id, member_id, last_window) VALUES (platform.current_community(), CAST(:member AS uuid), :window)
        ON CONFLICT (community_id, member_id) DO UPDATE SET last_window = excluded.last_window, used_at = now() WHERE gate.badge_use.last_window < excluded.last_window
        RETURNING last_window""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcGateStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    // passes
    @Override public List<Gate.Pass> passes(Spec<Gate.Pass> scope, String status) { Map<String, Object> p = new HashMap<>(scope.params()); p.put("status", status); return jdbc.query(passesSql(scope.sql()), p, (rs, i) -> pass(rs)); }
    @Override public Optional<Gate.Pass> pass(UUID id, Spec<Gate.Pass> scope) { Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString()); return jdbc.query(passSql(scope.sql()), p, (rs, i) -> pass(rs)).stream().findFirst(); }
    @Override public List<Gate.Pass> passesMatching(String q) { return jdbc.query(PASSES_MATCHING, Map.of("q", q, "like", Rows.like(q)), (rs, i) -> pass(rs)); }
    @Override public boolean codeInUse(String code) { return jdbc.queryForObject(CODE_IN_USE, Map.of("code", code), Long.class) > 0; }
    @Override public void insert(Gate.Pass x) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", x.id.toString()); p.put("name", x.visitorName); p.put("phone", x.phone); p.put("unit", uid(x.unit)); p.put("type", x.type); p.put("from", Rows.sqlDate(x.validFrom));
        p.put("to", Rows.sqlDate(x.validTo)); p.put("fromTime", t(x.fromTime)); p.put("toTime", t(x.toTime)); p.put("days", arr(x.days)); p.put("vehicle", x.vehicle); p.put("guestCap", x.guestCap);
        p.put("goodsKind", x.goodsKind); p.put("people", x.peopleCount); p.put("material", x.material); p.put("carryingOut", x.carryingOut); p.put("outItems", x.outItems); p.put("used", x.usedCount);
        p.put("code", x.code); p.put("photo", x.photo); p.put("host", x.hostName); p.put("status", x.status); p.put("createdBy", x.createdBy == null ? null : x.createdBy.toString());
        jdbc.query(PASS_INSERT, p, (rs, i) -> { x.shortId = rs.getString("short_id"); x.version = rs.getLong("version"); x.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean save(Gate.Pass x) { return bump(PASS_UPDATE, Map.of("id", x.id.toString(), "version", x.version, "used", x.usedCount, "status", x.status), (v) -> x.version = v); }

    // visits
    @Override public List<Gate.Visit> visits(Spec<Gate.Visit> scope, VisitFilter f) {
        Map<String, Object> p = new HashMap<>(scope.params());
        p.put("state", f.state()); p.put("unit", f.unit() == null ? null : f.unit().toString()); p.put("from", Rows.sqlDate(f.from())); p.put("to", Rows.sqlDate(f.to())); p.put("open", f.openOnly());
        return jdbc.query(visitsSql(scope.sql()), p, (rs, i) -> visit(rs));
    }
    @Override public Optional<Gate.Visit> visit(UUID id, Spec<Gate.Visit> scope) { Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString()); return jdbc.query(visitSql(scope.sql()), p, (rs, i) -> visit(rs)).stream().findFirst(); }
    @Override public Optional<Gate.Visit> insideByPerson(UUID person) { return jdbc.query(INSIDE_BY_PERSON, Map.of("person", person.toString()), (rs, i) -> visit(rs)).stream().findFirst(); }
    @Override public Optional<Gate.Visit> insideByMember(UUID member) { return jdbc.query(INSIDE_BY_MEMBER, Map.of("member", member.toString()), (rs, i) -> visit(rs)).stream().findFirst(); }
    @Override public byte[] badgeKey() {
        jdbc.update(BADGE_KEY_MAKE, Map.of());
        return jdbc.query(BADGE_KEY, Map.of(), (rs, i) -> rs.getBytes("secret")).get(0);
    }
    @Override public boolean useBadge(UUID member, long window) { return !jdbc.query(BADGE_USE, Map.of("member", member.toString(), "window", window), (rs, i) -> rs.getLong(1)).isEmpty(); }
    @Override public Optional<Gate.Visit> insideByPass(UUID pass) { return jdbc.query(INSIDE_BY_PASS, Map.of("pass", pass.toString()), (rs, i) -> visit(rs)).stream().findFirst(); }
    @Override public Optional<Gate.Visit> insideByPlate(String plate) { return jdbc.query(INSIDE_BY_PLATE, Map.of("plate", plate), (rs, i) -> visit(rs)).stream().findFirst(); }
    @Override public List<Gate.Visit> overdue(Instant before) { return jdbc.query(OVERDUE, Map.of("before", Rows.ts(before)), (rs, i) -> visit(rs)); }
    @Override public void insert(Gate.Visit v) {
        Map<String, Object> p = visitParams(v);
        p.put("name", v.name); p.put("kind", v.kind); p.put("unit", uid(v.unit)); p.put("gate", v.gate); p.put("company", v.company); p.put("vehicle", v.vehicle); p.put("phone", v.phone);
        p.put("purpose", v.purpose); p.put("photo", v.photo); p.put("person", s(v.personId)); p.put("member", s(v.memberId)); p.put("pass", s(v.passId)); p.put("workOrder", s(v.workOrderId)); p.put("approval", s(v.approvalId));
        p.put("hcExpected", v.headcountExpected); p.put("hcIn", v.headcountIn); p.put("material", v.material); p.put("carryingOut", v.carryingOut); p.put("outItems", v.outItems);
        p.put("verifiedBy", s(v.verifiedBy));
        jdbc.query(VISIT_INSERT, p, (rs, i) -> { v.shortId = rs.getString("short_id"); v.version = rs.getLong("version"); v.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean save(Gate.Visit v) { Map<String, Object> p = visitParams(v); p.put("version", v.version); return bump(VISIT_UPDATE, p, (x) -> v.version = x); }
    private Map<String, Object> visitParams(Gate.Visit v) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", v.id.toString()); p.put("state", v.state.label); p.put("method", v.method); p.put("inAt", Rows.ts(v.inAt)); p.put("outAt", Rows.ts(v.outAt)); p.put("expected", Rows.ts(v.expectedUntil));
        p.put("note", v.note); p.put("hcOut", v.headcountOut); p.put("openReason", v.openReason); p.put("outMethod", v.outMethod);
        return p;
    }

    // approvals
    @Override public List<Gate.Approval> approvals(Spec<Gate.Approval> scope, String status) { Map<String, Object> p = new HashMap<>(scope.params()); p.put("status", status); return jdbc.query(approvalsSql(scope.sql()), p, (rs, i) -> approval(rs)); }
    @Override public Optional<Gate.Approval> approval(UUID id, Spec<Gate.Approval> scope) { Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString()); return jdbc.query(approvalSql(scope.sql()), p, (rs, i) -> approval(rs)).stream().findFirst(); }
    @Override public List<Gate.Approval> expired(Instant now) { return jdbc.query(EXPIRED, Map.of("now", Rows.ts(now)), (rs, i) -> approval(rs)); }
    @Override public void insert(Gate.Approval a) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", a.id.toString()); p.put("name", a.name); p.put("unit", uid(a.unit)); p.put("company", a.company); p.put("purpose", a.purpose); p.put("vehicle", a.vehicle); p.put("gate", a.gate);
        p.put("photo", a.photo); p.put("visit", s(a.visitId)); p.put("kind", a.kind); p.put("status", a.status); p.put("requestedAt", Rows.ts(a.requestedAt)); p.put("expiresAt", Rows.ts(a.expiresAt));
        p.put("fallback", a.fallback);
        jdbc.query(APPROVAL_INSERT, p, (rs, i) -> { a.shortId = rs.getString("short_id"); a.version = rs.getLong("version"); return null; });
    }
    @Override public boolean save(Gate.Approval a) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", a.id.toString()); p.put("version", a.version); p.put("status", a.status); p.put("answeredAt", Rows.ts(a.answeredAt)); p.put("answeredBy", s(a.answeredBy)); p.put("always", a.alwaysAllow);
        return bump(APPROVAL_UPDATE, p, (v) -> a.version = v);
    }

    // flags
    @Override public List<Gate.Flag> flags(boolean openOnly) { return jdbc.query(FLAGS, Map.of("open", openOnly), (rs, i) -> flag(rs)); }
    @Override public Optional<Gate.Flag> flag(UUID id) { return jdbc.query(FLAG, Map.of("id", id.toString()), (rs, i) -> flag(rs)).stream().findFirst(); }
    @Override public boolean hasFlag(String type, UUID visit) { return jdbc.queryForObject(HAS_FLAG, Map.of("type", type, "visit", visit.toString()), Long.class) > 0; }
    @Override public List<Gate.Flag> openReports(UUID person) { return jdbc.query(OPEN_REPORTS, Map.of("person", person.toString()), (rs, i) -> flag(rs)); }
    @Override public boolean openFlagSince(String type, String name, Instant since) {
        return jdbc.queryForObject(OPEN_FLAG_SINCE, Map.of("type", type, "name", name == null ? "" : name, "since", Rows.ts(since)), Long.class) > 0;
    }
    @Override public boolean hasRoundFlag(UUID round, LocalDate day) { return jdbc.queryForObject(HAS_ROUND_FLAG, Map.of("round", round.toString(), "day", Rows.sqlDate(day)), Long.class) > 0; }
    @Override public void insert(Gate.Flag f) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", f.id.toString()); p.put("type", f.type); p.put("state", f.state); p.put("gate", f.gate); p.put("personName", f.personName); p.put("unit", uid(f.unit)); p.put("detail", f.detail);
        p.put("raisedAt", Rows.ts(f.raisedAt)); p.put("graceUntil", Rows.ts(f.graceUntil)); p.put("visit", s(f.visitId)); p.put("person", s(f.personId)); p.put("photo", f.photo);
        p.put("round", s(f.roundId)); p.put("day", Rows.sqlDate(f.day));
        jdbc.query(FLAG_INSERT, p, (rs, i) -> { f.shortId = rs.getString("short_id"); f.version = rs.getLong("version"); return null; });
    }
    @Override public boolean save(Gate.Flag f) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", f.id.toString()); p.put("version", f.version); p.put("state", f.state); p.put("resolution", f.resolution); p.put("note", f.resolutionNote); p.put("resolvedBy", s(f.resolvedBy));
        p.put("resolvedAt", Rows.ts(f.resolvedAt));
        return bump(FLAG_UPDATE, p, (v) -> f.version = v);
    }

    // scans
    @Override public Optional<Scan> lastScanOf(UUID guard) { return jdbc.query(LAST_SCAN, Map.of("guard", guard.toString()), (rs, i) -> scan(rs)).stream().findFirst(); }
    @Override public List<Scan> scans(UUID round, LocalDate day) { return jdbc.query(SCANS, Map.of("round", round.toString(), "day", Rows.sqlDate(day)), (rs, i) -> scan(rs)); }
    @Override public List<Scan> scansSince(LocalDate day) { return jdbc.query(SCANS_SINCE, Map.of("day", Rows.sqlDate(day)), (rs, i) -> scan(rs)); }
    @Override public void insert(Scan x) {
        Map<String, Object> p = new HashMap<>();
        p.put("cp", s(x.checkpointId())); p.put("cpName", x.checkpointName()); p.put("guard", s(x.guardId())); p.put("guardName", x.guard()); p.put("at", Rows.ts(x.at()));
        p.put("round", s(x.roundId())); p.put("roundName", x.roundName()); p.put("day", Rows.sqlDate(x.day())); p.put("note", x.note());
        p.put("lat", x.lat()); p.put("lng", x.lng()); p.put("acc", x.accM()); p.put("dist", x.distM()); p.put("place", x.place()); p.put("method", x.method());
        jdbc.update(SCAN_INSERT, p);
    }

    // ---- mapping -----------------------------------------------------------------------------------------------------------------------------
    private boolean bump(String sql, Map<String, Object> p, java.util.function.LongConsumer set) {
        List<Long> v = jdbc.query(sql, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        set.accept(v.get(0)); return true;
    }
    static Gate.Pass pass(ResultSet rs) throws SQLException {
        Gate.Pass p = new Gate.Pass();
        p.id = Rows.uuid(rs, "id"); p.shortId = rs.getString("short_id"); p.visitorName = rs.getString("visitor_name"); p.phone = rs.getString("phone"); p.unit = unit(rs, "unit_id");
        p.unitNo = rs.getString("unit_no"); p.type = rs.getString("type"); p.validFrom = Rows.date(rs, "valid_from"); p.validTo = Rows.date(rs, "valid_to"); p.fromTime = time(rs, "from_time");
        p.toTime = time(rs, "to_time"); p.days = Rows.list(rs, "days", String::valueOf); p.vehicle = rs.getString("vehicle"); p.guestCap = i(rs, "guest_cap"); p.goodsKind = rs.getString("goods_kind");
        p.peopleCount = i(rs, "people_count"); p.material = rs.getString("material"); p.carryingOut = rs.getBoolean("carrying_out"); p.outItems = rs.getString("out_items");
        p.usedCount = rs.getInt("used_count"); p.code = rs.getString("code"); p.photo = rs.getString("photo"); p.hostName = rs.getString("host_name"); p.status = rs.getString("status");
        p.createdBy = Rows.uuid(rs, "created_by_id"); p.createdAt = Rows.instant(rs, "created_at"); p.version = rs.getLong("version");
        return p;
    }
    static Gate.Visit visit(ResultSet rs) throws SQLException {
        Gate.Visit v = new Gate.Visit();
        v.id = Rows.uuid(rs, "id"); v.shortId = rs.getString("short_id"); v.name = rs.getString("name"); v.kind = rs.getString("kind"); v.unit = unit(rs, "unit_id"); v.unitNo = rs.getString("unit_no");
        v.gate = rs.getString("gate"); v.company = rs.getString("company"); v.vehicle = rs.getString("vehicle"); v.phone = rs.getString("phone"); v.purpose = rs.getString("purpose");
        v.state = Gate.VisitState.of(rs.getString("state")); v.method = rs.getString("method"); v.inAt = Rows.instant(rs, "in_at"); v.outAt = Rows.instant(rs, "out_at");
        v.expectedUntil = Rows.instant(rs, "expected_until"); v.photo = rs.getString("photo"); v.personId = Rows.uuid(rs, "person_id"); v.memberId = Rows.uuid(rs, "member_id"); v.passId = Rows.uuid(rs, "pass_id");
        v.workOrderId = Rows.uuid(rs, "work_order_id"); v.approvalId = Rows.uuid(rs, "approval_id"); v.note = rs.getString("note"); v.headcountExpected = i(rs, "headcount_expected");
        v.headcountIn = i(rs, "headcount_in"); v.headcountOut = i(rs, "headcount_out"); v.material = rs.getString("material"); v.carryingOut = rs.getBoolean("carrying_out");
        v.outItems = rs.getString("out_items"); v.openReason = rs.getString("open_reason"); v.outMethod = rs.getString("out_method"); v.verifiedBy = Rows.uuid(rs, "verified_by_id");
        v.verifiedByName = rs.getString("verified_by_name"); v.createdAt = Rows.instant(rs, "created_at"); v.version = rs.getLong("version");
        return v;
    }
    static Gate.Approval approval(ResultSet rs) throws SQLException {
        Gate.Approval a = new Gate.Approval();
        a.id = Rows.uuid(rs, "id"); a.shortId = rs.getString("short_id"); a.name = rs.getString("name"); a.unit = unit(rs, "unit_id"); a.unitNo = rs.getString("unit_no"); a.company = rs.getString("company");
        a.purpose = rs.getString("purpose"); a.vehicle = rs.getString("vehicle"); a.gate = rs.getString("gate"); a.photo = rs.getString("photo"); a.visitId = Rows.uuid(rs, "visit_id");
        a.kind = rs.getString("kind"); a.status = rs.getString("status"); a.requestedAt = Rows.instant(rs, "requested_at"); a.expiresAt = Rows.instant(rs, "expires_at"); a.fallback = rs.getString("fallback");
        a.answeredAt = Rows.instant(rs, "answered_at"); a.answeredBy = Rows.uuid(rs, "answered_by_id"); a.answeredByName = rs.getString("answered_by_name"); a.alwaysAllow = rs.getBoolean("always_allow");
        a.version = rs.getLong("version");
        return a;
    }
    static Gate.Flag flag(ResultSet rs) throws SQLException {
        Gate.Flag f = new Gate.Flag();
        f.id = Rows.uuid(rs, "id"); f.shortId = rs.getString("short_id"); f.type = rs.getString("type"); f.state = rs.getString("state"); f.gate = rs.getString("gate"); f.personName = rs.getString("person_name");
        f.unit = unit(rs, "unit_id"); f.detail = rs.getString("detail"); f.raisedAt = Rows.instant(rs, "raised_at"); f.graceUntil = Rows.instant(rs, "grace_until"); f.visitId = Rows.uuid(rs, "visit_id");
        f.personId = Rows.uuid(rs, "person_id"); f.photo = rs.getString("photo"); f.resolution = rs.getString("resolution"); f.resolutionNote = rs.getString("resolution_note");
        f.resolvedBy = Rows.uuid(rs, "resolved_by_id"); f.resolvedByName = rs.getString("resolved_by_name"); f.resolvedAt = Rows.instant(rs, "resolved_at"); f.roundId = Rows.uuid(rs, "round_id");
        f.day = Rows.date(rs, "day"); f.version = rs.getLong("version");
        return f;
    }
    static Scan scan(ResultSet rs) throws SQLException {
        return new Scan(Rows.uuid(rs, "checkpoint_id"), rs.getString("checkpoint_name"), Rows.uuid(rs, "guard_id"), rs.getString("guard"), Rows.instant(rs, "at"), Rows.uuid(rs, "round_id"),
            rs.getString("round_name"), Rows.date(rs, "day"), rs.getString("note"), dbl(rs, "lat"), dbl(rs, "lng"), i(rs, "acc_m"), i(rs, "dist_m"), rs.getString("place"), rs.getString("method"));
    }
    static UnitId unit(ResultSet rs, String c) throws SQLException { UUID u = Rows.uuid(rs, c); return u == null ? null : new UnitId(u); }
    static Double dbl(ResultSet rs, String c) throws SQLException { BigDecimal b = rs.getBigDecimal(c); return b == null ? null : b.doubleValue(); }
    static Integer i(ResultSet rs, String c) throws SQLException { BigDecimal b = rs.getBigDecimal(c); return b == null ? null : b.intValue(); }
    static LocalTime time(ResultSet rs, String c) throws SQLException { String s = rs.getString(c); return s == null ? null : LocalTime.parse(s); }
    static String t(LocalTime t) { return t == null ? null : t.toString(); }
    static String s(UUID u) { return u == null ? null : u.toString(); }
    static String uid(UnitId u) { return u == null ? null : u.toString(); }
    static String arr(List<String> l) { return Rows.pgArray(l); }
}
