package com.communityos.api.reports;

import com.communityos.api.reports.application.ReportService;
import com.communityos.api.reports.domain.Reports;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.Caller;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Report schedules (resource kit; when one last ran is the server's) and the sent reports (read only: written when a report is sent). */
public final class ReportResources {
    private ReportResources() {}
    static <F extends Record> Spec<F> reporters(Caller c) { return ReportService.reporter(c) ? Spec.all() : Spec.none(); }

    public record ScheduleFields(String name, String reportType, String period, String format, String frequency, LocalTime time, String weekday, Integer monthDay, List<String> channels,
                                 String audience, List<UUID> roleIds, List<UUID> unitIds, List<UUID> memberIds, String extra, Map<String, Object> recipe, List<String> showCols, Boolean showTax,
                                 Boolean showTotals, Boolean showSummary, String intro, String footer, Boolean skipEmpty, Boolean active) {}
    public static final Resource<ScheduleFields> SCHEDULES = new Resource<>(
        new ResourceTable<>("reportSchedules", "reports/schedules", "reports.schedule", ScheduleFields.class, "r.name").server("lastRunKey", Kind.TEXT),
        new ResourceRules<>() {
            @Override public Spec<ScheduleFields> readScope(Caller c) { return reporters(c); }
            @Override public boolean mayWrite(Caller c) { return ReportService.reporter(c); }
            @Override public ScheduleFields validate(Caller c, ScheduleFields f, ScheduleFields old) {
                String type = Checks.requiredOneOf(f.reportType(), "Report", List.of("bookings", "dues", "collections", "water", "tasks", "audits", "infra", "eventwork", "custom"));
                Checks.rule(!"custom".equals(type) || f.recipe() != null, "custom-required", "A custom report needs its recipe");
                Reports.Type t = Reports.type(type);
                Checks.rule(f.period() == null || t == null || t.periods().contains(f.period()) || "custom".equals(type), "bad-period", "That period does not fit this report");
                String freq = f.frequency() == null ? "Daily" : Checks.oneOf(f.frequency(), "Frequency", List.of("Daily", "Weekly", "Monthly"));
                Checks.oneOf(f.weekday(), "Weekday", List.of("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"));
                Checks.rule(f.monthDay() == null || (f.monthDay() >= 1 && f.monthDay() <= 31), "bad-day", "A day of the month is 1 to 31");
                String audience = f.audience() == null ? "Roles" : Checks.oneOf(f.audience(), "Audience", List.of("Roles", "People", "All villas", "Selected villas"));
                Checks.rule(!"Roles".equals(audience) || !Checks.list(f.roleIds()).isEmpty() || (f.extra() != null && !f.extra().isBlank()), "audience-required", "Send it to which roles?");
                Checks.rule(!"People".equals(audience) || !Checks.list(f.memberIds()).isEmpty(), "audience-required", "Send it to whom?");
                Checks.rule(!"Selected villas".equals(audience) || !Checks.list(f.unitIds()).isEmpty(), "audience-required", "Send it to which units?");
                for (String ch : Checks.list(f.channels())) Checks.oneOf(ch, "Channel", List.of("In-app", "Email", "SMS", "WhatsApp"));
                return new ScheduleFields(Checks.text(Checks.required(f.name(), "Name"), "Name", 120), type, f.period(), f.format() == null ? "Summary" : Checks.oneOf(f.format(), "Format",
                    List.of("Summary", "Detailed", "Excel", "CSV")), freq, f.time() == null ? LocalTime.of(8, 0) : f.time(), f.weekday(), f.monthDay(),
                    Checks.list(f.channels()).isEmpty() ? List.of("In-app") : f.channels(), audience, Checks.list(f.roleIds()), Checks.list(f.unitIds()), Checks.list(f.memberIds()),
                    Checks.text(f.extra(), "Other recipients", 1000), f.recipe(), Checks.list(f.showCols()), !Boolean.FALSE.equals(f.showTax()), Boolean.TRUE.equals(f.showTotals()),
                    !Boolean.FALSE.equals(f.showSummary()), Checks.text(f.intro(), "Intro", 2000),
                    Checks.text(f.footer(), "Footer", 2000), Boolean.TRUE.equals(f.skipEmpty()), f.active() == null ? Boolean.TRUE : f.active());
            }
            @Override public String label(ScheduleFields f) { return f.name(); }
        });

    public record RunFields(UUID scheduleId, String name, String title, String summary, List<String> columns, String sentTo) {}
    public static final Resource<RunFields> RUNS = new Resource<>(
        new ResourceTable<>("reportRuns", "reports/runs", "reports.run", RunFields.class, "r.run_at DESC")
            .server("runAt", Kind.TIMESTAMP).server("rows", Kind.JSON).server("reportType", Kind.TEXT).server("delivered", Kind.INT).server("manual", Kind.BOOL).filterBy("scheduleId"),
        new ResourceRules<>() {
            @Override public Spec<RunFields> readScope(Caller c) { return reporters(c); }
            @Override public boolean mayWrite(Caller c) { return false; }
            @Override public boolean mayChange(Caller c, Item<RunFields> it) { return false; }
            @Override public boolean deletable(RunFields f) { return false; }
        });

    public static List<Resource<?>> all() { return List.of(SCHEDULES, RUNS); }
}
