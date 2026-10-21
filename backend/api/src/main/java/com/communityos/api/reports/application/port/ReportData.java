package com.communityos.api.reports.application.port;

import com.communityos.api.reports.domain.Reports;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** What the reports read, and the schedules and sent reports - explicit SQL behind it (JdbcReportData). */
public interface ReportData {
    List<Reports.BookingRow> bookings(LocalDate from, LocalDate to, UUID unitId);
    List<Reports.DueRow> unpaidDues(UUID unitId);
    List<Reports.PaymentRow> payments(LocalDate from, LocalDate to);
    List<Reports.PlantRow> plantLogs(LocalDate from, LocalDate to);
    List<Reports.TaskRow> tasks();
    List<Reports.AuditRow> audits();
    /** Assets not working, or with an open task on them. */
    List<Reports.InfraRow> infra();
    List<Reports.WorkRow> pendingEventWork();
    String communityName();

    record Schedule(UUID id, String shortId, String name, String reportType, String period, String format, String frequency, LocalTime time, String weekday, Integer monthDay,
                    List<String> channels, String audience, List<UUID> roleIds, List<UUID> unitIds, List<UUID> memberIds, String extra, List<String> showCols, Boolean showTax,
                    Boolean showTotals, Boolean showSummary, String intro, String footer, boolean skipEmpty, boolean active, String lastRunKey, long version) {}
    List<Schedule> activeSchedules();
    Optional<Schedule> schedule(UUID id, boolean lock);
    void markRun(UUID scheduleId, String key);
    record Run(UUID id, UUID scheduleId, String name, String type, String title, String summary, List<String> columns, String rowsJson, String sentTo, LocalDate from, LocalDate to, int delivered, boolean manual) {}
    void insertRun(Run r);
    List<String> roleCodes(List<UUID> roleIds);
    record UnitRef(UUID id, String unitNo) {}
    /** Units with somebody who signs in (an occupant with portal access and a membership). */
    List<UnitRef> unitsWithPeople();
    List<UnitRef> units(List<UUID> ids);
    /** A message to an address that is not a member (an auditor's e-mail ...), queued for its channel. */
    void queueExtra(String channel, String to, String subject, String body);
}
