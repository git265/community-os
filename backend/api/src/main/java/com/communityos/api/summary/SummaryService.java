package com.communityos.api.summary;

import com.communityos.api.amenity.application.BookingPolicy;
import com.communityos.api.amenity.domain.Booking;
import com.communityos.api.billing.application.DuePolicy;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.gate.application.GatePolicy;
import com.communityos.api.gate.domain.Gate;
import com.communityos.api.maintenance.application.TicketPolicy;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * The counts and totals a page shows above its list, counted by the database from the same rows, with the same access rules, at the moment
 * they are asked for - so a number never disagrees with the list under it. Nothing is stored; each summary is one grouped query on indexed
 * columns. A caller sees the summaries of what they may see (a resident: their own unit's), and none of what they may not.
 */
public final class SummaryService {
    public record Late(java.util.UUID id, String shortId, String title, String category, String unitNo, String assignee, LocalDate slaDueAt) {}
    public record Tickets(long total, long active, long overdue, long assignedToMe, long raisedByMe, long awaitingApproval, long critical, long unassigned, long onHold,
                          long completed, long closedThisMonth, Map<String, Long> byStatus, List<Late> mostOverdue) {}
    public record Dues(long open, BigDecimal outstanding, long overdue, BigDecimal overdueAmount, BigDecimal collectedThisMonth, long unitsOwing) {}
    public record GateNow(long inside, long insideCrew, long awaitingApproval, long inToday, long outToday) {}
    public record Homes(long occupied, long total) {}
    public record Bookings(long today, long tomorrow, long pendingPayment, long refundsDue) {}
    public record Staff(long onDuty) {}
    /** The Command Center: every part the caller may see (a part they may not see is absent). */
    public record Dashboard(Homes homes, Tickets tickets, Dues dues, GateNow gate, Bookings bookings, Staff staff, long unreadNotifications) {}

    public static final String TICKETS = """
        SELECT t.status, count(*) AS n,
               count(*) FILTER (WHERE t.status IN ('Open', 'Assigned', 'In Progress', 'On Hold') AND t.sla_due_at::date < CAST(:today AS date)) AS overdue,
               count(*) FILTER (WHERE t.assignee_id = CAST(:me AS uuid) AND t.status IN ('Open', 'Assigned', 'In Progress', 'On Hold')) AS mine,
               count(*) FILTER (WHERE t.raised_by_id = CAST(:me AS uuid) AND t.status NOT IN ('Closed', 'Cancelled')) AS raised,
               count(*) FILTER (WHERE t.status NOT IN ('Closed', 'Cancelled') AND (t.ec_approval = 'Pending' OR t.treasurer_approval = 'Pending')) AS awaiting,
               count(*) FILTER (WHERE t.status NOT IN ('Closed', 'Cancelled') AND t.priority IN ('High', 'Critical')) AS critical,
               count(*) FILTER (WHERE t.status = 'Open' AND t.assignee_id IS NULL) AS unassigned,
               count(*) FILTER (WHERE t.status NOT IN ('Closed', 'Cancelled') AND (t.status = 'On Hold' OR t.awaiting_parts)) AS on_hold,
               count(*) FILTER (WHERE t.status = 'Closed' AND t.closed_at >= CAST(:month AS date)) AS closed_month
        FROM maintenance.ticket t
        LEFT JOIN maintenance.task_type tt ON tt.community_id = t.community_id AND tt.id = t.task_type_id
        LEFT JOIN property.unit u ON u.community_id = t.community_id AND u.id = t.unit_id
        WHERE %s GROUP BY t.status""";
    public static final String MOST_OVERDUE = """
        SELECT t.id, t.short_id, t.title, t.category, u.unit_no, a.display_name AS assignee, t.sla_due_at::date AS sla
        FROM maintenance.ticket t
        LEFT JOIN maintenance.task_type tt ON tt.community_id = t.community_id AND tt.id = t.task_type_id
        LEFT JOIN property.unit u ON u.community_id = t.community_id AND u.id = t.unit_id
        LEFT JOIN identity.membership a ON a.community_id = t.community_id AND a.id = t.assignee_id
        WHERE t.status IN ('Open', 'Assigned', 'In Progress', 'On Hold') AND t.sla_due_at::date < CAST(:today AS date) AND %s
        ORDER BY t.sla_due_at, t.id LIMIT 4""";
    public static final String HOMES = "SELECT count(*) FILTER (WHERE u.occupancy <> 'Vacant') AS occupied, count(*) AS total FROM property.unit u WHERE u.status = 'Active' AND %s";
    public static final String DUES = """
        SELECT count(*) FILTER (WHERE d.status IN ('Unpaid', 'Partly paid')) AS open_n,
               coalesce(sum(d.amount + d.tax_amount - d.paid_amount - d.credit_applied) FILTER (WHERE d.status IN ('Unpaid', 'Partly paid')), 0) AS outstanding,
               count(*) FILTER (WHERE d.status IN ('Unpaid', 'Partly paid') AND d.due_date < CAST(:today AS date)) AS overdue_n,
               coalesce(sum(d.amount + d.tax_amount - d.paid_amount - d.credit_applied) FILTER (WHERE d.status IN ('Unpaid', 'Partly paid') AND d.due_date < CAST(:today AS date)), 0) AS overdue_amount,
               coalesce(sum(d.paid_amount) FILTER (WHERE d.status = 'Paid' AND d.paid_at >= CAST(:month AS date)), 0) AS collected,
               count(DISTINCT d.unit_id) FILTER (WHERE d.status IN ('Unpaid', 'Partly paid')) AS units_owing
        FROM billing.due d
        JOIN billing.charge_category c ON c.community_id = d.community_id AND c.id = d.category_id
        LEFT JOIN property.unit u ON u.community_id = d.community_id AND u.id = d.unit_id
        WHERE %s""";
    public static final String GATE = """
        SELECT count(*) FILTER (WHERE v.state = 'Inside') AS inside, count(*) FILTER (WHERE v.state = 'Inside' AND v.kind = 'Crew') AS inside_crew,
               count(*) FILTER (WHERE v.state = 'Awaiting approval') AS awaiting,
               count(*) FILTER (WHERE v.in_at >= CAST(:dayStart AS timestamptz)) AS in_today,
               count(*) FILTER (WHERE v.out_at >= CAST(:dayStart AS timestamptz)) AS out_today
        FROM gate.visit v LEFT JOIN property.unit u ON u.community_id = v.community_id AND u.id = v.unit_id
        WHERE (v.state IN ('Inside', 'Awaiting approval') OR v.in_at >= CAST(:dayStart AS timestamptz) OR v.out_at >= CAST(:dayStart AS timestamptz)) AND %s""";
    public static final String BOOKINGS = """
        SELECT count(*) FILTER (WHERE b.date = CAST(:today AS date) AND b.status <> 'Cancelled') AS today,
               count(*) FILTER (WHERE b.date = CAST(:today AS date) + 1 AND b.status <> 'Cancelled') AS tomorrow,
               count(*) FILTER (WHERE b.status = 'Pending payment') AS pending,
               count(*) FILTER (WHERE b.refund_status IN ('Refund due', 'Refund initiated') OR b.deposit_refund_status IN ('Due', 'Initiated')) AS refunds
        FROM amenity.booking b
        WHERE (b.date >= CAST(:today AS date) OR b.status = 'Pending payment' OR b.refund_status IN ('Refund due', 'Refund initiated') OR b.deposit_refund_status IN ('Due', 'Initiated')) AND %s""";
    public static final String ON_DUTY = "SELECT count(*) AS n FROM workforce.attendance_session a WHERE a.clock_out IS NULL";
    public static final String UNREAD = "SELECT count(*) AS n FROM comms.notification n WHERE n.to_membership_id = CAST(:me AS uuid) AND n.read_at IS NULL";

    private final NamedParameterJdbcTemplate jdbc; private final Clock clock; private final ZoneId zone;
    private final TicketPolicy tickets = new TicketPolicy(); private final DuePolicy dues = new DuePolicy(); private final BookingPolicy bookings = new BookingPolicy();
    public SummaryService(NamedParameterJdbcTemplate jdbc, Clock clock, ZoneId zone) { this.jdbc = jdbc; this.clock = clock; this.zone = zone; }

    private LocalDate today() { return LocalDate.now(clock.withZone(zone)); }
    private Map<String, Object> params(Spec<?> s, Caller c) {
        Map<String, Object> p = new HashMap<>(s.params());
        LocalDate t = today();
        p.put("today", java.sql.Date.valueOf(t)); p.put("month", java.sql.Date.valueOf(t.withDayOfMonth(1)));
        p.put("dayStart", java.sql.Timestamp.from(t.atStartOfDay(zone).toInstant()));
        p.put("me", c.membership() == null ? null : c.membership().value().toString());
        return p;
    }

    public Tickets tickets(Caller c) {
        Spec<Ticket> s = tickets.readScope(c);
        Map<String, Long> by = new LinkedHashMap<>(); long[] agg = new long[9];
        jdbc.query(TICKETS.formatted(s.sql()), params(s, c), (rs, i) -> {
            long n = rs.getLong("n"); by.put(rs.getString("status"), n);
            agg[0] += n; agg[1] += rs.getLong("overdue"); agg[2] += rs.getLong("mine"); agg[3] += rs.getLong("raised"); agg[4] += rs.getLong("awaiting");
            agg[5] += rs.getLong("critical"); agg[6] += rs.getLong("unassigned"); agg[7] += rs.getLong("on_hold"); agg[8] += rs.getLong("closed_month");
            return n;
        });
        long active = List.of("Open", "Assigned", "In Progress", "On Hold").stream().mapToLong((k) -> by.getOrDefault(k, 0L)).sum();
        List<Late> late = jdbc.query(MOST_OVERDUE.formatted(s.sql()), params(s, c), (rs, i) -> new Late(rs.getObject("id", java.util.UUID.class), rs.getString("short_id"), rs.getString("title"),
            rs.getString("category"), rs.getString("unit_no"), rs.getString("assignee"), rs.getDate("sla") == null ? null : rs.getDate("sla").toLocalDate()));
        return new Tickets(agg[0], active, agg[1], agg[2], agg[3], agg[4], agg[5], agg[6], agg[7], by.getOrDefault("Completed", 0L), agg[8], by, late);
    }
    /** null when the caller sees no bills at all (staff without the bills' permissions). */
    public Dues dues(Caller c) {
        Spec<Due> s = dues.readScope(c);
        if ("FALSE".equals(s.sql())) return null;
        return jdbc.query(DUES.formatted(s.sql()), params(s, c), (rs, i) -> new Dues(rs.getLong("open_n"), money(rs, "outstanding"), rs.getLong("overdue_n"), money(rs, "overdue_amount"),
            money(rs, "collected"), rs.getLong("units_owing"))).get(0);
    }
    public GateNow gate(Caller c) {
        Spec<Gate.Visit> s = GatePolicy.byUnit(c, "v.unit_id", (Gate.Visit v) -> v.unit);
        return jdbc.query(GATE.formatted(s.sql()), params(s, c), (rs, i) -> new GateNow(rs.getLong("inside"), rs.getLong("inside_crew"), rs.getLong("awaiting"), rs.getLong("in_today"), rs.getLong("out_today"))).get(0);
    }
    public Bookings bookings(Caller c) {
        Spec<Booking> s = bookings.readScope(c);
        return jdbc.query(BOOKINGS.formatted(s.sql()), params(s, c), (rs, i) -> new Bookings(rs.getLong("today"), rs.getLong("tomorrow"), rs.getLong("pending"), rs.getLong("refunds"))).get(0);
    }
    /** null for a resident (who is on duty is the staff's business). */
    public Staff staff(Caller c) {
        if (c.isResident() && !c.isSuperAdmin()) return null;
        return new Staff(jdbc.queryForObject(ON_DUTY, Map.of(), Long.class));
    }
    public Homes homes(Caller c) {
        Spec<com.communityos.api.property.domain.Unit> s = new com.communityos.api.property.application.UnitPolicy().readScope(c);
        return jdbc.query(HOMES.formatted(s.sql()), params(s, c), (rs, i) -> new Homes(rs.getLong("occupied"), rs.getLong("total"))).get(0);
    }
    public Dashboard dashboard(Caller c) {
        long unread = c.membership() == null ? 0 : jdbc.queryForObject(UNREAD, Map.of("me", c.membership().value().toString()), Long.class);
        return new Dashboard(homes(c), tickets(c), dues(c), gate(c), bookings(c), staff(c), unread);
    }
    private static BigDecimal money(ResultSet rs, String col) throws SQLException { BigDecimal b = rs.getBigDecimal(col); return b == null ? BigDecimal.ZERO : b.setScale(2, java.math.RoundingMode.HALF_UP); }
}
