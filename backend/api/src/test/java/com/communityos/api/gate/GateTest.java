package com.communityos.api.gate;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.gate.domain.Gate;
import com.communityos.api.shared.domain.DomainException;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The gate's pure rules: windows, quiet hours, pass validity, the visit's states. */
class GateTest {
    static final ZoneId IST = ZoneId.of("Asia/Kolkata");
    static final ZonedDateTime TUE_10 = ZonedDateTime.of(2026, 10, 20, 10, 0, 0, 0, IST);   // a Tuesday

    @Test void windows() {
        assertEquals("Tue", Gate.dayOf(TUE_10.toLocalDate()));
        assertTrue(Gate.windowOpen(List.of(), null, null, TUE_10, 0));
        assertFalse(Gate.windowOpen(List.of("Mon", "Wed"), null, null, TUE_10, 0));
        assertTrue(Gate.windowOpen(List.of("Tue"), LocalTime.of(9, 0), LocalTime.of(12, 0), TUE_10, 0));
        assertFalse(Gate.windowOpen(List.of(), LocalTime.of(10, 30), null, TUE_10, 0));
        assertTrue(Gate.windowOpen(List.of(), LocalTime.of(10, 10), null, TUE_10, 15), "slack");
        Gate.Settings s = new Gate.Settings(60, "Hold at gate", 30, 10, 2, LocalTime.of(22, 0), LocalTime.of(6, 0), "Deny", null, 20, Map.of("Guest", 240), List.of());
        assertTrue(s.quiet(TUE_10.withHour(23))); assertTrue(s.quiet(TUE_10.withHour(5))); assertFalse(s.quiet(TUE_10));
        assertEquals(240, s.minutesFor("Guest")); assertEquals(120, s.minutesFor("Cab")); assertEquals(0, s.minutesFor("Resident vehicle"));
    }

    @Test void passes() {
        Gate.Pass p = new Gate.Pass();
        p.type = "One-time"; p.validFrom = LocalDate.of(2026, 10, 20); p.validTo = LocalDate.of(2026, 10, 20);
        assertEquals("", p.problem(TUE_10));
        assertEquals("Expired on 2026-10-20", p.problem(TUE_10.plusDays(1)));
        assertEquals("Not valid before 2026-10-20", p.problem(TUE_10.minusDays(1)));
        p.used(); assertEquals("Used", p.status); assertEquals("This one-time pass has already been used", p.problem(TUE_10));
        Gate.Pass r = new Gate.Pass();
        r.type = "Recurring"; r.days = List.of("Mon"); assertEquals("Outside the days or hours of this pass", r.problem(TUE_10));
        r.days = List.of("Tue"); r.fromTime = LocalTime.of(8, 0); r.toTime = LocalTime.of(9, 0); assertTrue(r.problem(TUE_10).startsWith("Outside"));
        r.toTime = LocalTime.of(11, 0); assertEquals("", r.problem(TUE_10)); r.used(); assertEquals("Active", r.status, "a recurring pass is used many times");
        Gate.Pass e = new Gate.Pass();
        e.type = "Event"; e.guestCap = 2; e.usedCount = 2; assertEquals("Guest limit of 2 reached", e.problem(TUE_10));
    }

    @Test void staffBadge() {
        byte[] key = new byte[32]; byte[] other = new byte[32]; other[0] = 1;
        java.util.UUID m = java.util.UUID.randomUUID(); java.time.Instant t = java.time.Instant.parse("2026-10-20T04:00:10Z");
        String text = com.communityos.api.gate.domain.StaffBadge.text(key, m, t);
        assertEquals(m, com.communityos.api.gate.domain.StaffBadge.check(key, text, t.plusSeconds(25)).member(), "the next window is accepted (clock skew)");
        assertEquals("badge-old", assertThrows(DomainException.RuleViolated.class, () -> com.communityos.api.gate.domain.StaffBadge.check(key, text, t.plusSeconds(95))).code());
        assertEquals("badge-invalid", assertThrows(DomainException.RuleViolated.class, () -> com.communityos.api.gate.domain.StaffBadge.check(other, text, t)).code(), "another community's key");
        assertEquals("not-a-badge", assertThrows(DomainException.RuleViolated.class, () -> com.communityos.api.gate.domain.StaffBadge.check(key, "GGB|x|1|ab", t)).code());
        String forged = text.replace("|" + com.communityos.api.gate.domain.StaffBadge.window(t) + "|", "|" + (com.communityos.api.gate.domain.StaffBadge.window(t) + 1) + "|");
        assertEquals("badge-invalid", assertThrows(DomainException.RuleViolated.class, () -> com.communityos.api.gate.domain.StaffBadge.check(key, forged, t)).code(), "the window is signed");
    }
    @Test void visitStates() {
        Gate.Visit v = new Gate.Visit();
        v.state = Gate.VisitState.AWAITING;
        v.move(Gate.VisitState.APPROVED); v.move(Gate.VisitState.INSIDE); v.move(Gate.VisitState.EXITED);
        assertThrows(DomainException.RuleViolated.class, () -> v.move(Gate.VisitState.INSIDE), "an exited visit is over");
        Gate.Visit d = new Gate.Visit(); d.state = Gate.VisitState.DENIED;
        assertThrows(DomainException.RuleViolated.class, () -> d.move(Gate.VisitState.INSIDE), "denied means an override, not a let-in");
        assertEquals("Awaiting approval", Gate.VisitState.of("Awaiting approval").label);
    }
}
