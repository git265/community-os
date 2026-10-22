package com.communityos.api.workforce;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.workforce.application.AttendanceService;
import com.communityos.api.workforce.application.port.AttendanceStore;
import com.communityos.api.workforce.domain.Attendance;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Distance to the site, lateness, hours; clocking in and out as strictly as the community chose; a supervisor's correction; the forgotten session. */
class WorkforceTest {
    static final ZoneId IST = ZoneId.of("Asia/Kolkata");
    static final BigDecimal SITE_LAT = new BigDecimal("12.9716"), SITE_LNG = new BigDecimal("77.5946");
    static Attendance.Settings settings(String enforcement) { return new Attendance.Settings("Main gate", SITE_LAT, SITE_LNG, 300, enforcement, 15, Map.of("Morning", "06:00", "General", "09:00"), BigDecimal.valueOf(12)); }
    static final class MovingClock extends Clock {
        Instant now = Instant.parse("2026-10-20T03:50:00Z");   // 09:20 in India
        @Override public ZoneId getZone() { return IST; } @Override public Clock withZone(ZoneId z) { return this; } @Override public Instant instant() { return now; }
    }

    @Test void rules() {
        assertTrue(Math.abs(Attendance.distanceM(0, 0, 1, 0) - 111_195) < 5, "one degree of latitude");
        var s = settings(Attendance.RECORD);
        assertEquals("Inside site", Attendance.fix(new BigDecimal("12.9720"), new BigDecimal("77.5950"), null, s).site());
        assertEquals("Outside site", Attendance.fix(new BigDecimal("12.9900"), SITE_LNG, null, s).site());
        assertEquals("No location", Attendance.fix(null, null, null, s).site());
        Instant at0920 = Instant.parse("2026-10-20T03:50:00Z");
        assertEquals(5, Attendance.lateMinutes("General", s, at0920, IST), "20 minutes after 09:00, less 15 grace");
        assertEquals(0, Attendance.lateMinutes("Night", s, at0920, IST)); assertEquals(0, Attendance.lateMinutes("Unknown", s, at0920, IST));
        assertEquals(0, Attendance.lateMinutes("General", s, Instant.parse("2026-10-20T03:00:00Z"), IST), "early is not late");
        assertEquals(new BigDecimal("8.50"), Attendance.hours(at0920, at0920.plus(Duration.ofMinutes(510))));
    }

    @Test void clocking() {
        Store store = new Store(); MovingClock clock = new MovingClock();
        AttendanceService svc = new AttendanceService(store, new Fixtures.Audit(), Tx.direct(), clock);
        Caller ravi = Fixtures.caller(Caller.Category.Staff, Set.of("handyman_plumber"), Set.of(), Set.of());
        Caller sup = Fixtures.caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of(), Permission.MANAGE_FIELD_DUTIES);
        assertThrows(AccessDenied.class, () -> svc.clockIn(Fixtures.owner(Fixtures.UNIT_A), null, null, null), "residents do not clock in");
        store.settings = settings(Attendance.INSIDE);
        assertEquals("location-required", assertThrows(DomainException.RuleViolated.class, () -> svc.clockIn(ravi, null, null, null)).code());
        assertEquals("outside-site", assertThrows(DomainException.RuleViolated.class, () -> svc.clockIn(ravi, new AttendanceService.Position(new BigDecimal("13.1"), SITE_LNG, null), null, null)).code());
        store.shift = "General";
        var in = svc.clockIn(ravi, new AttendanceService.Position(new BigDecimal("12.9718"), SITE_LNG, new BigDecimal("12")), null, null);
        assertEquals(clock.now, in.clockIn, "the server's time"); assertEquals("General", in.shiftType, "the planned shift"); assertEquals(5, (int) in.lateMin); assertEquals("Inside site", in.in.site());
        assertTrue(store.onDuty.get(ravi.membership().value()));
        assertEquals("already-in", assertThrows(DomainException.RuleViolated.class, () -> svc.clockIn(ravi, new AttendanceService.Position(new BigDecimal("12.9718"), SITE_LNG, null), null, null)).code());
        clock.now = clock.now.plus(Duration.ofHours(8)).plus(Duration.ofMinutes(15));
        var out = svc.clockOut(ravi, null, "done");
        assertEquals(new BigDecimal("8.25"), out.hours); assertEquals("No location", out.out.site(), "inside is needed to clock in, not out");
        assertFalse(store.onDuty.get(ravi.membership().value()));
        assertEquals("not-in", assertThrows(DomainException.RuleViolated.class, () -> svc.clockOut(ravi, null, null)).code());
        assertEquals(1, svc.list(ravi, null, null, sup.membership().value()).size(), "staff see their own, whatever they ask for");

        assertThrows(AccessDenied.class, () -> svc.correct(ravi, out.id, out.version, new AttendanceService.Correction(out.clockIn, out.clockOut, "x")));
        assertEquals("reason-required", assertThrows(DomainException.RuleViolated.class, () -> svc.correct(sup, out.id, out.version, new AttendanceService.Correction(out.clockIn, out.clockOut, " "))).code());
        var fixed = svc.correct(sup, out.id, out.version, new AttendanceService.Correction(out.clockIn.minus(Duration.ofMinutes(30)), out.clockOut, "Forgot to clock in at the gate"));
        assertEquals("Supervisor", fixed.source); assertEquals(new BigDecimal("8.75"), fixed.hours); assertEquals(sup.membership().value(), fixed.correctedById);
        assertEquals("bad-times", assertThrows(DomainException.RuleViolated.class, () -> svc.correct(sup, out.id, fixed.version, new AttendanceService.Correction(out.clockOut, out.clockIn, "swap"))).code());

        store.settings = settings(Attendance.RECORD);
        svc.clockIn(ravi, null, "Morning", null);
        clock.now = clock.now.plus(Duration.ofHours(13));
        assertEquals(1, svc.closeOverdue(com.communityos.api.shared.security.SystemCaller.of(Fixtures.COMMUNITY, "attendance")));
        var closed = store.rows.values().stream().filter((x) -> "Auto-closed".equals(x.source)).findFirst().orElseThrow();
        assertEquals(new BigDecimal("12.00"), closed.hours); assertTrue(closed.note.contains("no clock-out"));
    }

    static Attendance.Session session(UUID m, String name, String in, String out) {
        Attendance.Session x = new Attendance.Session(); x.id = UUID.randomUUID(); x.memberId = m; x.staffName = name; x.clockIn = Instant.parse(in); x.clockOut = out == null ? null : Instant.parse(out);
        x.date = LocalDate.ofInstant(x.clockIn, IST); return x;
    }
    @Test void gateBesideTheClock() {
        UUID ravi = UUID.randomUUID(), meena = UUID.randomUUID(), arun = UUID.randomUUID();
        Instant now = Instant.parse("2026-10-20T14:00:00Z");   // 19:30 IST
        // Ravi: gate 09:00-17:40, clock 08:40-18:00 (clocked in before the gate, left the gate before clocking out)
        // Meena: gate 08:55-still inside, clock 09:00-17:00 (still inside after clocking out)
        // Arun: at the gate 10:00-12:00, never clocked in
        var sessions = List.of(session(ravi, "Ravi", "2026-10-20T03:10:00Z", "2026-10-20T12:30:00Z"), session(meena, "Meena", "2026-10-20T03:30:00Z", "2026-10-20T11:30:00Z"));
        var stays = List.of(new Attendance.GateStay(ravi, "Ravi", Instant.parse("2026-10-20T03:30:00Z"), Instant.parse("2026-10-20T12:10:00Z")),
            new Attendance.GateStay(meena, "Meena", Instant.parse("2026-10-20T03:25:00Z"), null),
            new Attendance.GateStay(arun, "Arun", Instant.parse("2026-10-20T04:30:00Z"), Instant.parse("2026-10-20T06:30:00Z")));
        var lines = Attendance.withGate(sessions, stays, IST, 15, now);
        assertEquals(3, lines.size());
        var r = lines.stream().filter((l) -> l.memberId().equals(ravi)).findFirst().orElseThrow();
        assertEquals(List.of(Attendance.BEFORE_GATE, Attendance.LEFT_EARLY), r.flags()); assertEquals(new BigDecimal("8.67"), r.gateHours());
        var m = lines.stream().filter((l) -> l.memberId().equals(meena)).findFirst().orElseThrow();
        assertTrue(m.gateInside()); assertEquals(List.of(Attendance.STAYED), m.flags());
        var a = lines.stream().filter((l) -> l.memberId().equals(arun)).findFirst().orElseThrow();
        assertNull(a.session()); assertEquals(List.of(Attendance.GATE_ONLY), a.flags()); assertEquals(new BigDecimal("2.00"), a.gateHours());
        // within the tolerance: nothing to say
        var fine = Attendance.withGate(List.of(session(ravi, "Ravi", "2026-10-20T03:25:00Z", "2026-10-20T12:00:00Z")), List.of(stays.get(0)), IST, 15, now);
        assertEquals(List.of(), fine.get(0).flags());
        // a community that does not use badges: no "no gate entry" flags at all; one that does: said for the day without a badge
        assertEquals(List.of(), Attendance.withGate(sessions, List.of(), IST, 15, now).get(0).flags());
        var none = Attendance.withGate(sessions, List.of(stays.get(2)), IST, 15, now);
        assertTrue(none.stream().filter((l) -> l.session() != null).allMatch((l) -> l.flags().equals(List.of(Attendance.NO_GATE))));
        assertEquals(List.of(), Attendance.withGate(List.of(session(meena, "Meena", "2026-10-17T03:30:00Z", "2026-10-17T11:30:00Z")), List.of(stays.get(2)), IST, 15, now).stream()
            .filter((l) -> l.session() != null).findFirst().orElseThrow().flags(), "before the gate recorded any staff, nothing is missing");
        // clocked in, badge out already: left without clocking out
        var open = Attendance.withGate(List.of(session(ravi, "Ravi", "2026-10-20T03:25:00Z", null)), List.of(stays.get(0)), IST, 15, now);
        assertEquals(List.of(Attendance.LEFT_CLOCKED), open.get(0).flags());
        // a night shift across midnight keeps its gate times (22:00 to 06:00 IST); a badge far from any session is a day at the gate
        var night = session(ravi, "Ravi", "2026-10-20T16:30:00Z", "2026-10-21T00:30:00Z");
        var nl = Attendance.withGate(List.of(night), List.of(new Attendance.GateStay(ravi, "Ravi", Instant.parse("2026-10-20T16:25:00Z"), Instant.parse("2026-10-21T00:35:00Z")),
            new Attendance.GateStay(ravi, "Ravi", Instant.parse("2026-10-21T10:00:00Z"), Instant.parse("2026-10-21T11:00:00Z"))), IST, 15, Instant.parse("2026-10-21T12:00:00Z"));
        assertEquals(2, nl.size()); assertEquals(List.of(), nl.stream().filter((l) -> l.session() != null).findFirst().orElseThrow().flags());
        assertEquals(List.of(Attendance.GATE_ONLY), nl.stream().filter((l) -> l.session() == null).findFirst().orElseThrow().flags());
    }
    @Test void reportScope() {
        Store store = new Store(); MovingClock clock = new MovingClock();
        AttendanceService svc = new AttendanceService(store, new Fixtures.Audit(), Tx.direct(), clock);
        Caller ravi = Fixtures.caller(Caller.Category.Staff, Set.of("handyman_plumber"), Set.of(), Set.of());
        UUID other = UUID.randomUUID();
        store.rows.put(UUID.randomUUID(), session(ravi.membership().value(), "Ravi", "2026-10-20T03:25:00Z", null));
        store.rows.put(UUID.randomUUID(), session(other, "Meena", "2026-10-20T03:25:00Z", null));
        assertEquals(1, svc.report(ravi, null, null, other).size(), "staff see their own, whoever they ask for");
        assertThrows(AccessDenied.class, () -> svc.report(Fixtures.owner(Fixtures.UNIT_A), null, null, null));
        assertEquals("bad-period", assertThrows(DomainException.RuleViolated.class, () -> svc.report(ravi, LocalDate.of(2026, 10, 2), LocalDate.of(2026, 10, 1), null)).code());
    }
    static final class Store implements AttendanceStore {
        Attendance.Settings settings = WorkforceTest.settings(Attendance.RECORD); String shift; final Map<UUID, Attendance.Session> rows = new LinkedHashMap<>(); final Map<UUID, Boolean> onDuty = new LinkedHashMap<>();
        @Override public Attendance.Settings settings() { return settings; }
        @Override public Optional<Attendance.Session> openSession(UUID memberId) { return rows.values().stream().filter((x) -> x.memberId.equals(memberId) && x.open()).findFirst(); }
        @Override public List<Attendance.Session> overdue() { return rows.values().stream().filter(Attendance.Session::open).toList(); }
        @Override public Optional<Attendance.Session> session(UUID id, boolean lock) { return Optional.ofNullable(rows.get(id)); }
        @Override public List<Attendance.Session> sessions(LocalDate from, LocalDate to, UUID memberId) { return new ArrayList<>(rows.values().stream().filter((x) -> memberId == null || x.memberId.equals(memberId)).toList()); }
        @Override public void insert(Attendance.Session s) { s.id = UUID.randomUUID(); s.version = 1; rows.put(s.id, s); }
        @Override public boolean update(Attendance.Session s) { s.version++; return true; }
        @Override public boolean delete(UUID id, long version) { return rows.remove(id) != null; }
        @Override public String shiftOf(UUID memberId, LocalDate date) { return shift; }
        @Override public void onDuty(UUID memberId, boolean on) { onDuty.put(memberId, on); }
        @Override public String roleName(UUID memberId) { return "Plumber"; }
        @Override public List<Team> teams() { return List.of(); }
        final List<Attendance.GateStay> stays = new ArrayList<>();
        @Override public List<Attendance.GateStay> gateStays(LocalDate from, LocalDate to, UUID memberId, ZoneId zone) { return stays.stream().filter((g) -> memberId == null || g.memberId().equals(memberId)).toList(); }
    }
}
