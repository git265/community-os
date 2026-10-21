package com.communityos.api.reports.application;

import com.communityos.api.comms.application.port.Inbox;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.reports.application.port.ReportData;
import com.communityos.api.reports.domain.Reports;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

/**
 * Reports. A report is built on the server from the community's own data (never from what a screen sends): on demand for the people who run
 * reports, and for a resident only the per-unit reports of their own unit. A schedule sends its report when due (the job) or when run by
 * hand: to roles, members or units - each unit its own version of a per-unit report - through the inbox and the channels people chose, plus
 * any extra addresses; what was sent is kept (Reports -> Sent).
 */
public final class ReportService {
    public record Built(Reports.Report report, String text) {}
    public record Sent(UUID runId, String sentTo, int delivered, boolean silent) {}

    private final ReportData data; private final Inbox inbox; private final ObjectMapper json; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public ReportService(ReportData data, Inbox inbox, ObjectMapper json, AuditWriter audit, Tx tx, Clock clock) {
        this.data = data; this.inbox = inbox; this.json = json; this.audit = audit; this.tx = tx; this.clock = clock;
    }
    /** Runs reports and their schedules: the committee, the facility manager, notification managers and the super admin (and the scheduler). */
    public static boolean reporter(Caller c) {
        return c.isSuperAdmin() || c.isCommittee() || c.roleCodes().contains("facility_manager") || c.has(Permission.MANAGE_NOTIFICATIONS) || c.category() == Caller.Category.System;
    }
    LocalDate today() { return LocalDate.now(clock); }

    public Built build(Caller c, String type, String period, UUID unitId) {
        Reports.Type t = known(type);
        UUID unit = unitId;
        if (!reporter(c)) {
            if (!c.isResident() || !t.perUnit()) throw new AccessDenied("Only the committee and the facility manager run this report");
            List<UUID> mine = c.units().stream().map((u) -> u.value()).sorted().toList();
            if (mine.isEmpty()) throw new AccessDenied("No unit to report on");
            if (unit == null) unit = mine.get(0);
            if (!mine.contains(unit)) throw new AccessDenied("Only your own unit");
        }
        if (unit != null && !t.perUnit()) unit = null;
        final UUID u = unit;
        return tx.inTx(() -> {
            String unitNo = u == null ? null : data.units(List.of(u)).stream().findFirst().map(ReportData.UnitRef::unitNo).orElseThrow(() -> new DomainException.NotFound("Unit"));
            Reports.Report r = make(t, period, u, unitNo, Reports.Show.ALL);
            return new Built(r, Reports.text(r, "Detailed", data.communityName(), Reports.Show.ALL));
        });
    }

    Reports.Report make(Reports.Type t, String period, UUID unit, String unitNo, Reports.Show show) {
        LocalDate today = today();
        Reports.Range r = Reports.range(t, period, today);
        Reports.Report raw = switch (t.id()) {
            case "bookings" -> Reports.bookings(data.bookings(r.from(), r.to(), unit), r, unitNo);
            case "dues" -> Reports.dues(data.unpaidDues(unit), today, unitNo);
            case "collections" -> Reports.collections(data.payments(r.from(), r.to()));
            case "water" -> Reports.water(data.plantLogs(r.from(), r.to()));
            case "tasks" -> Reports.tasks(data.tasks(), r, today, clock.getZone());
            case "audits" -> Reports.audits(data.audits(), today);
            case "infra" -> Reports.infra(data.infra());
            case "eventwork" -> Reports.eventWork(data.pendingEventWork(), r, today);
            default -> throw new DomainException.RuleViolated("bad-report", "Unknown report");
        };
        return Reports.shape(raw, t, show, r, today);
    }
    static Reports.Type known(String type) {
        if ("custom".equals(type)) throw new DomainException.RuleViolated("custom-on-screen", "A custom report is built on the screen; the server runs the built-in reports");
        Reports.Type t = Reports.type(type);
        if (t == null) throw new DomainException.RuleViolated("bad-report", "Unknown report " + type);
        return t;
    }

    /** Send a schedule's report now (by hand) - or, from the job, when it is due. */
    public Sent run(Caller c, UUID scheduleId, boolean manual) {
        if (!reporter(c)) throw new AccessDenied("Only the committee, the facility manager or notification managers run reports");
        return tx.inTx(() -> {
            ReportData.Schedule s = data.schedule(scheduleId, true).orElseThrow(() -> new DomainException.NotFound("Report schedule"));
            return send(c, s, manual, manual ? null : today().toString());
        });
    }

    /** The job: every schedule due now in this community. */
    public int runDue(Caller system) {
        ZonedDateTime now = ZonedDateTime.now(clock);
        int n = 0;
        for (ReportData.Schedule s : data.activeSchedules()) {
            if ("custom".equals(s.reportType())) continue;
            String key = Reports.dueKey(s.active(), s.frequency(), s.time(), s.weekday(), s.monthDay(), s.lastRunKey(), now);
            if (key.isEmpty()) continue;
            try {
                tx.inTx(() -> {
                    ReportData.Schedule locked = data.schedule(s.id(), true).orElseThrow();
                    if (key.equals(locked.lastRunKey())) return null;   // another instance sent it
                    return send(system, locked, false, key);
                });
                n++;
            } catch (RuntimeException e) { /* one schedule failing does not stop the others; it is tried again on the next tick */ }
        }
        return n;
    }

    Sent send(Caller c, ReportData.Schedule s, boolean manual, String key) {
        Reports.Type t = known(s.reportType());
        Reports.Show show = new Reports.Show(s.showCols() == null ? List.of() : s.showCols(), !Boolean.FALSE.equals(s.showTax()), Boolean.TRUE.equals(s.showTotals()),
            !Boolean.FALSE.equals(s.showSummary()), s.intro(), s.footer());
        String format = s.format() == null ? "Summary" : s.format();
        String community = data.communityName();
        Reports.Report whole = make(t, s.period(), null, null, show);
        List<String> channels = s.channels() == null || s.channels().isEmpty() ? List.of("In-app") : s.channels();
        int delivered = 0; String sentTo;
        if (!manual && s.skipEmpty() && whole.empty()) {
            if (key != null) data.markRun(s.id(), key);
            return new Sent(null, "nothing to report", 0, true);
        }
        UUID runId = UUID.randomUUID();
        String wholeText = Reports.text(whole, format, community, show);
        switch (s.audience()) {
            case "All villas", "Selected villas" -> {
                List<ReportData.UnitRef> units = "All villas".equals(s.audience()) ? data.unitsWithPeople() : data.units(s.unitIds() == null ? List.of() : s.unitIds());
                int reached = 0;
                for (ReportData.UnitRef u : units) {
                    Reports.Report mine = t.perUnit() ? make(t, s.period(), u.id(), u.unitNo(), show) : whole;
                    if (t.perUnit() && mine.empty()) continue;
                    delivered += inbox.deliver(new Comms.Message("report", "report", mine.title(), Reports.text(mine, format, community, show), "#/reports", runId, Comms.To.unit(u.id())));
                    reached++;
                }
                sentTo = reached + " unit" + (reached == 1 ? "" : "s") + (t.perUnit() ? " (each sees only its own)" : "");
            }
            case "People" -> {
                List<UUID> people = s.memberIds() == null ? List.of() : s.memberIds();
                for (UUID m : people) delivered += inbox.deliver(new Comms.Message("report", "report", whole.title(), wholeText, "#/reports", runId, Comms.To.member(m)));
                sentTo = people.size() + (people.size() == 1 ? " person" : " people");
            }
            default -> {
                List<String> codes = data.roleCodes(s.roleIds() == null ? List.of() : s.roleIds());
                if (!codes.isEmpty()) delivered += inbox.deliver(new Comms.Message("report", "report", whole.title(), wholeText, "#/reports", runId, Comms.To.roles(codes.toArray(String[]::new))));
                sentTo = codes.size() + " role" + (codes.size() == 1 ? "" : "s");
            }
        }
        List<String> extra = extras(s.extra());
        for (String x : extra) {
            String channel = x.contains("@") ? "Email" : "SMS";
            if (channels.contains(channel)) data.queueExtra(channel, x, whole.title(), wholeText);
        }
        if (!extra.isEmpty()) sentTo += " + " + extra.size() + " other";
        String rows;
        try { rows = json.writeValueAsString(whole.rows()); } catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException(e); }
        String note = sentTo + " · " + String.join(", ", channels) + (manual ? " · run by hand" : "");
        data.insertRun(new ReportData.Run(runId, s.id(), s.name(), t.id(), whole.title(), String.join("\n", whole.lines()), whole.columns(), rows, note, whole.from(), whole.to(), delivered, manual));
        if (key != null) data.markRun(s.id(), key);
        audit.write(c, AuditWriter.Action.Create, "reports.run", runId, null, null, s.name() + ": sent to " + note, List.of());
        return new Sent(runId, sentTo, delivered, false);
    }
    static List<String> extras(String text) {
        if (text == null || text.isBlank()) return List.of();
        List<String> out = new ArrayList<>();
        for (String x : Arrays.stream(text.split("[,;\\s]+")).map(String::strip).filter((v) -> !v.isEmpty()).toList()) {
            if (x.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+") || x.matches("\\+?[0-9]{8,15}")) out.add(x);
        }
        return out.stream().limit(20).toList();
    }
}
