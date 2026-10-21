package com.communityos.api.workforce;

import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.workforce.application.WorkforcePolicy;
import com.communityos.api.workforce.domain.Attendance;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** The site and its rules, and planned shifts (resource kit). Attendance itself is AttendanceService. */
public final class WorkforceResources {
    private WorkforceResources() {}
    static final String HHMM = "([01][0-9]|2[0-3]):[0-5][0-9]";
    static String time(String t, String label) {
        if (t == null || t.isBlank()) return null;
        Checks.rule(t.strip().matches(HHMM), "bad-time", label + " is a time like 09:30");
        return t.strip();
    }
    static final List<String> WEEKDAYS = List.of("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun");
    static List<String> weekdays(List<String> w) {
        for (String d : Checks.list(w)) Checks.rule(WEEKDAYS.contains(d), "bad-weekday", "Weekdays are Mon to Sun");
        return Checks.list(w);
    }

    /** One per community (created with it); the supervisors set it. */
    public record SettingFields(String siteName, BigDecimal siteLat, BigDecimal siteLng, Integer radiusM, String enforcement, Integer graceMinutes, Map<String, Object> shiftStarts, BigDecimal maxShiftHours) {}
    public static final Resource<SettingFields> SETTINGS = new Resource<>(
        new ResourceTable<>("attendanceSettings", "workforce/attendance-settings", "workforce.attendance_setting", SettingFields.class, "r.created_at"),
        new ResourceRules<>() {
            @Override public Spec<SettingFields> readScope(Caller c) { return WorkforcePolicy.reader(c) ? Spec.all() : Spec.none(); }
            @Override public boolean mayWrite(Caller c) { return WorkforcePolicy.supervisor(c); }
            @Override public boolean deletable(SettingFields f) { return false; }
            @Override public SettingFields validate(Caller c, SettingFields f, SettingFields old) {
                Checks.rule(old != null, "one-setting", "The community has one attendance setting - change it");
                String enf = f.enforcement() == null ? Attendance.RECORD : Checks.oneOf(f.enforcement(), "Enforcement", List.of(Attendance.RECORD, Attendance.NEED, Attendance.INSIDE));
                Checks.rule(f.siteLat() == null || f.siteLat().abs().compareTo(BigDecimal.valueOf(90)) <= 0, "bad-position", "Latitude is -90 to 90");
                Checks.rule(f.siteLng() == null || f.siteLng().abs().compareTo(BigDecimal.valueOf(180)) <= 0, "bad-position", "Longitude is -180 to 180");
                Checks.rule(!Attendance.INSIDE.equals(enf) || (f.siteLat() != null && f.siteLng() != null), "site-required", "Set the site's position to require clocking in inside it");
                Checks.rule(f.radiusM() == null || (f.radiusM() >= 10 && f.radiusM() <= 20_000), "bad-radius", "The radius is 10 m to 20 km");
                Checks.rule(f.graceMinutes() == null || (f.graceMinutes() >= 0 && f.graceMinutes() <= 240), "bad-grace", "Grace is 0 to 240 minutes");
                Map<String, Object> starts = f.shiftStarts() == null ? (old == null ? Map.of() : old.shiftStarts()) : f.shiftStarts();
                for (var e : starts.entrySet()) Checks.rule(e.getValue() instanceof String s && s.matches(HHMM), "bad-time", e.getKey() + " starts at a time like 06:00");
                BigDecimal max = f.maxShiftHours() == null ? BigDecimal.valueOf(12) : f.maxShiftHours();
                Checks.rule(max.compareTo(BigDecimal.ONE) >= 0 && max.compareTo(BigDecimal.valueOf(24)) <= 0, "bad-hours", "A shift is 1 to 24 hours");
                return new SettingFields(Checks.text(f.siteName(), "Site", 120), f.siteLat(), f.siteLng(), f.radiusM(), enf, f.graceMinutes(), starts, max);
            }
        });

    public record HolidayFields(LocalDate date, String name, String trash, LocalDate trashNewDate, String workers, String workersFrom, String workersTo, String note, String effects) {}
    public static final Resource<HolidayFields> HOLIDAYS = new Resource<>(
        new ResourceTable<>("siteHolidays", "workforce/holidays", "workforce.site_holiday", HolidayFields.class, "r.date"),
        new ResourceRules<>() {
            @Override public Spec<HolidayFields> readScope(Caller c) { return WorkforcePolicy.member(c) ? Spec.all() : Spec.none(); }
            @Override public boolean mayWrite(Caller c) { return WorkforcePolicy.siteRules(c); }
            @Override public HolidayFields validate(Caller c, HolidayFields f, HolidayFields old) {
                Checks.rule(f.date() != null, "date-required", "Which day?");
                String trash = Checks.oneOf(f.trash(), "Trash", List.of("No pickup", "Pickup as usual", "Rescheduled"));
                Checks.rule(!"Rescheduled".equals(trash) || f.trashNewDate() != null, "new-date-required", "Rescheduled to which day?");
                String workers = Checks.oneOf(f.workers(), "Workers", List.of("Not allowed", "Allowed as usual", "Limited hours"));
                String from = time(f.workersFrom(), "From"), to = time(f.workersTo(), "To");
                Checks.rule(!"Limited hours".equals(workers) || (from != null && to != null), "hours-required", "Limited to which hours?");
                return new HolidayFields(f.date(), Checks.required(f.name(), "Holiday"), trash, "Rescheduled".equals(trash) ? f.trashNewDate() : null, workers,
                    "Limited hours".equals(workers) ? from : null, "Limited hours".equals(workers) ? to : null, Checks.text(f.note(), "Note", 500), f.effects());
            }
            @Override public String label(HolidayFields f) { return f.name(); }
        });
    public record ServiceFields(String name, String icon, String mode, String startTime, String endTime, List<String> weekdays, String area, String notes, Boolean active, Integer order) {}
    public static final Resource<ServiceFields> SERVICES = new Resource<>(
        new ResourceTable<>("siteServices", "workforce/services", "workforce.site_service", ServiceFields.class, "r.order_value NULLS LAST, r.name", Map.of("order", "order_value")),
        new ResourceRules<>() {
            @Override public Spec<ServiceFields> readScope(Caller c) { return WorkforcePolicy.member(c) ? Spec.all() : Spec.none(); }
            @Override public boolean mayWrite(Caller c) { return WorkforcePolicy.siteRules(c); }
            @Override public ServiceFields validate(Caller c, ServiceFields f, ServiceFields old) {
                return new ServiceFields(Checks.required(f.name(), "Service"), f.icon(), Checks.oneOf(f.mode(), "Mode", List.of("Collection", "Access")), time(f.startTime(), "Start"),
                    time(f.endTime(), "End"), weekdays(f.weekdays()), f.area(), Checks.text(f.notes(), "Notes", 500), f.active() == null ? Boolean.TRUE : f.active(), f.order());
            }
            @Override public String label(ServiceFields f) { return f.name(); }
        });
    public record CalendarFields(String kind, String title, String repeat, List<String> weekdays, LocalDate date, LocalDate endDate, String startTime, String endTime, String allowed, String area, String notes) {}
    public static final Resource<CalendarFields> CALENDAR = new Resource<>(
        new ResourceTable<>("siteCalendar", "workforce/calendar", "workforce.site_calendar_rule", CalendarFields.class, "r.date NULLS FIRST, r.title"),
        new ResourceRules<>() {
            @Override public Spec<CalendarFields> readScope(Caller c) { return WorkforcePolicy.member(c) ? Spec.all() : Spec.none(); }
            @Override public boolean mayWrite(Caller c) { return WorkforcePolicy.siteRules(c); }
            @Override public CalendarFields validate(Caller c, CalendarFields f, CalendarFields old) {
                String repeat = Checks.oneOf(f.repeat(), "Repeat", List.of("Weekly", "One date", "Date range"));
                Checks.rule(!"One date".equals(repeat) || f.date() != null, "date-required", "Which date?");
                Checks.rule(!"Date range".equals(repeat) || (f.date() != null && f.endDate() != null), "dates-required", "From and to which dates?");
                Checks.rule(f.endDate() == null || f.date() == null || !f.endDate().isBefore(f.date()), "bad-dates", "The range ends before it starts");
                return new CalendarFields(f.kind(), Checks.required(f.title(), "Title"), repeat, weekdays(f.weekdays()), f.date(), f.endDate(), time(f.startTime(), "Start"), time(f.endTime(), "End"),
                    Checks.oneOf(f.allowed(), "Allowed", List.of("Allowed", "Not allowed")), f.area(), Checks.text(f.notes(), "Notes", 500));
            }
            @Override public String label(CalendarFields f) { return f.title(); }
        });
    /** A planned shift: one per field-staff member and day (the staff member's name and trade come from field staff). */
    public record ShiftFields(UUID staffId, LocalDate date, String shiftType, String note) {}
    public static final Resource<ShiftFields> SHIFTS = new Resource<>(
        new ResourceTable<>("shifts", "workforce/shifts", "workforce.shift", ShiftFields.class, "r.date, r.staff_id")
            .computed("staffName", Kind.TEXT, "(SELECT f.name FROM maintenance.field_staff f WHERE f.community_id = r.community_id AND f.id = r.staff_id)")
            .computed("trade", Kind.TEXT, "(SELECT f.trade FROM maintenance.field_staff f WHERE f.community_id = r.community_id AND f.id = r.staff_id)").filterBy("staffId", "date"),
        new ResourceRules<>() {
            @Override public Spec<ShiftFields> readScope(Caller c) { return WorkforcePolicy.reader(c) ? Spec.all() : Spec.none(); }
            @Override public boolean mayWrite(Caller c) { return WorkforcePolicy.supervisor(c); }
            @Override public ShiftFields validate(Caller c, ShiftFields f, ShiftFields old) {
                Checks.rule(f.staffId() != null, "staff-required", "Whose shift?"); Checks.rule(f.date() != null, "date-required", "Which day?");
                return new ShiftFields(f.staffId(), f.date(), Checks.text(Checks.required(f.shiftType(), "Shift"), "Shift", 40), Checks.text(f.note(), "Note", 500));
            }
        });

    public static List<Resource<?>> all() { return List.of(SETTINGS, HOLIDAYS, SERVICES, CALENDAR, SHIFTS); }
}
