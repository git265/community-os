package com.communityos.api.reports;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.comms.application.port.Inbox;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.reports.application.ReportService;
import com.communityos.api.reports.application.port.ReportData;
import com.communityos.api.reports.domain.Reports;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.security.SystemCaller;
import com.communityos.api.shared.tx.Tx;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The reports as the app has always written them, what a schedule shows, when it is due, and sending: per unit, to roles, extra addresses, the record kept. */
class ReportsTest {
    static final LocalDate TODAY = LocalDate.of(2026, 10, 20);
    static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    @Test void periodsAndDue() {
        Reports.Type dues = Reports.type("dues"), water = Reports.type("water");
        assertEquals(new Reports.Range("prevMonth", "Last month", LocalDate.of(2026, 9, 1), LocalDate.of(2026, 9, 30)), Reports.range(water, "prevMonth", TODAY));
        assertEquals("last7", Reports.range(water, "nonsense", TODAY).id(), "an unknown period is the report's default");
        assertEquals(TODAY.minusDays(6), Reports.range(water, "last7", TODAY).from());
        assertEquals("asof", Reports.range(dues, null, TODAY).id());
        ZonedDateTime tue9 = ZonedDateTime.of(TODAY, LocalTime.of(9, 0), IST);   // 20 Oct 2026 is a Tuesday
        assertEquals("2026-10-20", Reports.dueKey(true, "Daily", LocalTime.of(8, 0), null, null, "2026-10-19", tue9));
        assertEquals("", Reports.dueKey(true, "Daily", LocalTime.of(8, 0), null, null, "2026-10-20", tue9), "once a day");
        assertEquals("", Reports.dueKey(true, "Daily", LocalTime.of(10, 0), null, null, null, tue9), "not before its time");
        assertEquals("", Reports.dueKey(true, "Weekly", LocalTime.of(8, 0), "Monday", null, null, tue9));
        assertEquals("2026-10-20", Reports.dueKey(true, "Weekly", LocalTime.of(8, 0), "Tuesday", null, null, tue9));
        assertEquals("2026-02-28", Reports.dueKey(true, "Monthly", LocalTime.of(8, 0), null, 31, null, ZonedDateTime.of(LocalDate.of(2026, 2, 28), LocalTime.NOON, IST)), "the 31st in February is its last day");
        assertEquals("", Reports.dueKey(false, "Daily", LocalTime.MIDNIGHT, null, null, null, tue9));
    }

    @Test void builders() {
        Reports.Range r = Reports.range(Reports.type("bookings"), "today_tomorrow", TODAY);
        UUID a = UUID.randomUUID();
        var bookings = List.of(new Reports.BookingRow(TODAY, "18:00", "Clubhouse", a, "Villa 101", "Booked", "Paid", new BigDecimal("2000"), new BigDecimal("360"), new BigDecimal("2360")),
            new Reports.BookingRow(TODAY.plusDays(1), "09:00", "Tennis", a, "Villa 101", "Booked", "Pending", BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO),
            new Reports.BookingRow(TODAY, "10:00", "Tennis", a, "Villa 101", "Cancelled", null, null, null, null));
        Reports.Report b = Reports.bookings(bookings, r, null);
        assertEquals("2 bookings · 1 cancelled · 1 payment pending", b.lines().get(0));
        assertEquals(8, b.columns().size()); assertEquals("20 Oct 2026", b.rows().get(0).get(0));
        var dues = List.of(new Reports.DueRow(a, "Villa 101", "Maintenance", LocalDate.of(2026, 9, 1), new BigDecimal("3540"), new BigDecimal("540"), TODAY.minusDays(5)),
            new Reports.DueRow(UUID.randomUUID(), "Villa 202", "Water", LocalDate.of(2026, 10, 1), new BigDecimal("800"), BigDecimal.ZERO, TODAY.plusDays(5)));
        Reports.Report d = Reports.dues(dues, TODAY, null);
        assertEquals("Outstanding ₹4,340 in 2 bills from 2 units · overdue ₹3,540", d.lines().get(0));
        assertEquals("Overdue", d.rows().get(0).get(6)); assertEquals("Sep 2026", d.rows().get(0).get(2));
        Reports.Report shaped = Reports.shape(d, Reports.type("dues"), new Reports.Show(List.of(), false, true, true, null, null), Reports.range(Reports.type("dues"), null, TODAY), TODAY);
        assertFalse(shaped.columns().contains("Tax (₹)"), "tax columns hidden when asked");
        assertEquals("Total", shaped.rows().get(2).get(0)); assertEquals(new BigDecimal("4340.00"), shaped.rows().get(2).get(3));
        assertNull(shaped.periodLabel(), "as of now has no period line");
        String text = Reports.text(shaped, "Detailed", "Palm Meadows", new Reports.Show(List.of(), false, true, true, "Good morning", "- the office"));
        assertTrue(text.startsWith("*Palm Meadows · Dues outstanding* · 20 Oct 2026")); assertTrue(text.contains("• Villa 101 · Maintenance")); assertTrue(text.endsWith("- the office"));
        var tasks = List.of(new Reports.TaskRow("TKT-1051", "Leak", "Plumbing", "High", "Assigned", "Ravi", Instant.parse("2026-10-18T00:00:00Z"), Instant.parse("2026-10-17T00:00:00Z"), null),
            new Reports.TaskRow("TKT-1052", "Light", "Electrical", "Low", "Closed", "Ravi", null, Instant.parse("2026-10-01T00:00:00Z"), Instant.parse("2026-10-19T05:00:00Z")));
        Reports.Report t = Reports.tasks(tasks, Reports.range(Reports.type("tasks"), "last7", TODAY), TODAY, IST);
        assertEquals("1 open · 1 past their due date · 1 raised and 1 closed in the period", t.lines().get(0)); assertEquals("Late", t.rows().get(0).get(7));
        var audits = List.of(new Reports.AuditRow("Pool", TODAY.minusMonths(7), "Pass", new BigDecimal("90"), TODAY.minusDays(3)), new Reports.AuditRow("Pool", TODAY.minusMonths(13), "Fail", null, null),
            new Reports.AuditRow("Lift", TODAY.minusMonths(2), "Fail", null, TODAY.plusDays(10)));
        Reports.Report au = Reports.audits(audits, TODAY);
        assertEquals("2 areas audited · 1 overdue · 1 due in 30 days · 1 last audit failed", au.lines().get(0)); assertEquals("Overdue by 3 days", au.rows().get(0).get(5));
        assertTrue(Reports.water(List.of()).empty());
    }

    @Test void sending() {
        Data data = new Data(); List<Comms.Message> sent = new ArrayList<>();
        Inbox inbox = new Inbox() {
            @Override public int deliver(Comms.Message m) { sent.add(m); return 1; }
            @Override public List<Comms.Note> mine(UUID membership, boolean unreadOnly, int limit) { return List.of(); }
            @Override public int unread(UUID membership) { return 0; }
            @Override public int markRead(UUID membership, UUID id) { return 0; }
        };
        ReportService svc = new ReportService(data, inbox, new ObjectMapper(), new Fixtures.Audit(), Tx.direct(), Fixtures.CLOCK, IST);
        Caller owner = Fixtures.owner(Fixtures.UNIT_A), fm = Fixtures.caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of());
        assertThrows(AccessDenied.class, () -> svc.build(owner, "tasks", null, null), "residents get only their own unit's reports");
        assertThrows(AccessDenied.class, () -> svc.build(owner, "dues", null, Fixtures.UNIT_B.value()));
        assertEquals("Your dues · Villa 1", svc.build(owner, "dues", null, null).report().title());
        assertEquals(Fixtures.UNIT_A.value(), data.lastUnit, "the dues of their own unit only");
        assertEquals("custom-on-screen", assertThrows(DomainException.RuleViolated.class, () -> svc.build(fm, "custom", null, null)).code());
        assertTrue(ReportService.reporter(Fixtures.caller(Caller.Category.Staff, Set.of("x"), Set.of(), Set.of(), Permission.MANAGE_NOTIFICATIONS)));

        UUID s1 = data.add("Dues to villas", "dues", "All villas", List.of(), List.of("In-app", "Email"), "auditor@ca.in, junk, +919845012345");
        ReportService.Sent r1 = svc.run(fm, s1, true);
        assertEquals(2, sent.size(), "each unit with dues gets its own (Villa 3 owes nothing)");
        assertEquals(Set.of(Fixtures.UNIT_A.value()), sent.get(0).to().units()); assertTrue(sent.get(0).title().startsWith("Your dues"));
        assertEquals(List.of("Email:auditor@ca.in"), data.extra, "the e-mail on an e-mail channel; the phone has no SMS channel here; junk is ignored");
        assertEquals("2 units (each sees only its own) + 2 other", r1.sentTo());
        assertEquals(1, data.runs.size()); assertTrue(data.runs.get(0).manual()); assertNull(data.lastKey.get(s1), "a run by hand does not use up the day's run");

        UUID s2 = data.add("Tasks to FM", "tasks", "Roles", List.of(UUID.randomUUID()), List.of(), null);
        sent.clear();
        assertEquals(2, svc.runDue(SystemCaller.of(Fixtures.COMMUNITY, "reports")), "both schedules are due at 11:30 on their day");
        assertEquals("2026-10-20", data.lastKey.get(s2));
        assertTrue(sent.stream().anyMatch((m) -> m.to().roles().contains("facility_manager")));
        assertEquals(0, svc.runDue(SystemCaller.of(Fixtures.COMMUNITY, "reports")), "not twice a day");
    }

    static final class Data implements ReportData {
        final List<Schedule> schedules = new ArrayList<>(); final List<Run> runs = new ArrayList<>(); final List<String> extra = new ArrayList<>(); final Map<UUID, String> lastKey = new java.util.HashMap<>();
        UUID lastUnit; final UUID unit3 = UUID.randomUUID();
        UUID add(String name, String type, String audience, List<UUID> roles, List<String> channels, String extra) {
            UUID id = UUID.randomUUID();
            schedules.add(new Schedule(id, "RS-1", name, type, null, "Summary", "Daily", LocalTime.of(8, 0), null, null, channels, audience, roles, List.of(), List.of(), extra, List.of(), null, null, null, null, null, false, true, null, 1));
            return id;
        }
        @Override public List<Reports.BookingRow> bookings(LocalDate from, LocalDate to, UUID unitId) { return List.of(); }
        @Override public List<Reports.DueRow> unpaidDues(UUID unitId) {
            lastUnit = unitId;
            List<Reports.DueRow> all = List.of(new Reports.DueRow(Fixtures.UNIT_A.value(), "Villa 1", "Maintenance", null, new BigDecimal("3540"), BigDecimal.ZERO, TODAY.minusDays(1)),
                new Reports.DueRow(Fixtures.UNIT_B.value(), "Villa 2", "Water", null, new BigDecimal("800"), BigDecimal.ZERO, TODAY.plusDays(1)));
            return all.stream().filter((d) -> unitId == null || d.unitId().equals(unitId)).toList();
        }
        @Override public List<Reports.PaymentRow> payments(LocalDate from, LocalDate to) { return List.of(); }
        @Override public List<Reports.PlantRow> plantLogs(LocalDate from, LocalDate to) { return List.of(); }
        @Override public List<Reports.TaskRow> tasks() { return List.of(); }
        @Override public List<Reports.AuditRow> audits() { return List.of(); }
        @Override public List<Reports.InfraRow> infra() { return List.of(); }
        @Override public List<Reports.WorkRow> pendingEventWork() { return List.of(); }
        @Override public String communityName() { return "Palm Meadows"; }
        @Override public List<Schedule> activeSchedules() { return schedules.stream().map((s) -> withKey(s)).toList(); }
        Schedule withKey(Schedule s) { return new Schedule(s.id(), s.shortId(), s.name(), s.reportType(), s.period(), s.format(), s.frequency(), s.time(), s.weekday(), s.monthDay(), s.channels(), s.audience(),
            s.roleIds(), s.unitIds(), s.memberIds(), s.extra(), s.showCols(), s.showTax(), s.showTotals(), s.showSummary(), s.intro(), s.footer(), s.skipEmpty(), s.active(), lastKey.get(s.id()), s.version()); }
        @Override public Optional<Schedule> schedule(UUID id, boolean lock) { return schedules.stream().filter((s) -> s.id().equals(id)).findFirst().map(this::withKey); }
        @Override public void markRun(UUID scheduleId, String key) { lastKey.put(scheduleId, key); }
        @Override public void insertRun(Run r) { runs.add(r); }
        @Override public List<String> roleCodes(List<UUID> roleIds) { return roleIds.isEmpty() ? List.of() : List.of("facility_manager"); }
        @Override public List<UnitRef> unitsWithPeople() { return List.of(new UnitRef(Fixtures.UNIT_A.value(), "Villa 1"), new UnitRef(Fixtures.UNIT_B.value(), "Villa 2"), new UnitRef(unit3, "Villa 3")); }
        @Override public List<UnitRef> units(List<UUID> ids) { return unitsWithPeople().stream().filter((u) -> ids.contains(u.id())).toList(); }
        @Override public void queueExtra(String channel, String to, String subject, String body) { extra.add(channel + ":" + to); }
    }
}
