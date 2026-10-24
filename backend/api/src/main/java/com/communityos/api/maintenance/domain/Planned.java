package com.communityos.api.maintenance.domain;

import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.Ids.CommunityId;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.IsoFields;
import java.util.List;
import java.util.UUID;

/**
 * Planned works: a checklist is done once a period (a day, a week, a month, a quarter, a half-year or a year) and is due by a day in it.
 * The same rules as the app (src/lib/plannedWorks.js periodOf): the period's key names its round, so one round is kept per period.
 */
public final class Planned {
    private Planned() {}
    public static final List<String> FREQUENCIES = List.of("Daily", "Weekly", "Monthly", "Quarterly", "Half-yearly", "Yearly");
    /** What a task in a round says: not done yet (blank), Done, Not OK, or not applicable this time. */
    public static final List<String> RESULTS = List.of("", "Done", "Not OK", "N/A");

    /** One period of a checklist: its key (W:2026-W43, M:2026-10 ...), its first and last day, and the day it is due by. */
    public record Period(String key, LocalDate start, LocalDate end, LocalDate dueOn) {}

    /**
     * The period `day` falls in. dueDay: for a weekly checklist 1 (Monday) to 7 (Sunday), otherwise the day of the month (a short month uses
     * its last day); dueMonth: the month within the quarter, half-year or year. Left out, a round is due by the period's last day.
     */
    public static Period of(String frequency, Integer dueDay, Integer dueMonth, LocalDate day) {
        int y = day.getYear(), m = day.getMonthValue();
        switch (frequency) {
            case "Daily": return new Period("D:" + day, day, day, day);
            case "Weekly": {
                LocalDate start = day.with(DayOfWeek.MONDAY);
                int d = dueDay == null ? 7 : Math.max(1, Math.min(7, dueDay));
                return new Period(String.format("W:%d-W%02d", day.get(IsoFields.WEEK_BASED_YEAR), day.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)), start, start.plusDays(6), start.plusDays(d - 1));
            }
            case "Monthly": {
                LocalDate start = day.withDayOfMonth(1);
                return new Period(String.format("M:%d-%02d", y, m), start, start.plusMonths(1).minusDays(1), dayIn(start, dueDay));
            }
            case "Quarterly": return span("Q:%d-Q%d", y, (m - 1) / 3, 3, dueDay, dueMonth);
            case "Half-yearly": return span("H:%d-H%d", y, (m - 1) / 6, 6, dueDay, dueMonth);
            case "Yearly": {
                LocalDate start = LocalDate.of(y, 1, 1);
                int mm = dueMonth == null ? 12 : Math.max(1, Math.min(12, dueMonth));
                return new Period("Y:" + y, start, LocalDate.of(y, 12, 31), dayIn(start.plusMonths(mm - 1), dueDay));
            }
            default: throw new IllegalArgumentException("Frequency: " + String.join(", ", FREQUENCIES));
        }
    }
    private static Period span(String fmt, int y, int index, int months, Integer dueDay, Integer dueMonth) {
        LocalDate start = LocalDate.of(y, index * months + 1, 1);
        int mm = dueMonth == null ? months : Math.max(1, Math.min(months, dueMonth));
        return new Period(String.format(fmt, y, index + 1), start, start.plusMonths(months).minusDays(1), dayIn(start.plusMonths(mm - 1), dueDay));
    }
    private static LocalDate dayIn(LocalDate monthStart, Integer dueDay) {
        int last = monthStart.lengthOfMonth();
        return monthStart.withDayOfMonth(dueDay == null ? last : Math.max(1, Math.min(last, dueDay)));
    }
    /** The letter a period key starts with, for a frequency (D, W, M, Q, H, Y). */
    public static String prefix(String frequency) {
        return switch (frequency) { case "Daily" -> "D"; case "Weekly" -> "W"; case "Monthly" -> "M"; case "Quarterly" -> "Q"; case "Half-yearly" -> "H"; default -> "Y"; };
    }

    /** A round to remind about: due today (to the team or person), or past its day and not done (to them and the facility manager). */
    public record RoundDue(UUID checklistId, CommunityId communityId, String name, String area, String period, LocalDate dueOn, String kind, String assigneeRole, UUID assigneeId,
                           Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "maintenance.planned." + kind; } @Override public UUID aggregateId() { return checklistId; }
    }
}
