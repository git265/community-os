package com.communityos.api.reports.domain;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.NumberFormat;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.TextStyle;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * The reports the server builds - the same eight the app offers (src/lib/reports/catalog.js), each a pure function of the rows it is given:
 * a title, summary lines, columns and rows. Also the periods, what a schedule chose to show, the text of a sent report, and when a schedule
 * is due.
 */
public final class Reports {
    private Reports() {}

    public record Report(String type, String title, List<String> lines, List<String> columns, List<List<Object>> rows, boolean empty, String periodLabel, LocalDate today,
                         LocalDate from, LocalDate to, Set<String> taxCols, Set<String> moneyCols) {}
    public record Range(String id, String label, LocalDate from, LocalDate to) {}
    public record Type(String id, String label, String group, boolean perUnit, boolean taxAware, List<String> periods, String defaultPeriod) {}

    public static final List<Type> TYPES = List.of(
        new Type("bookings", "Amenity bookings", "Amenities", true, true, List.of("today_tomorrow", "today", "tomorrow", "yesterday", "next7", "last7", "mtd"), "today_tomorrow"),
        new Type("dues", "Dues outstanding", "Billing", true, true, List.of("asof"), "asof"),
        new Type("collections", "Payments received", "Billing", false, false, List.of("yesterday", "last7", "mtd", "prevMonth", "last30"), "yesterday"),
        new Type("water", "Water & plant log", "Utilities", false, false, List.of("last7", "yesterday", "mtd", "prevMonth", "last30"), "last7"),
        new Type("tasks", "Maintenance tasks", "Maintenance", false, false, List.of("yesterday", "last7", "mtd", "last30"), "last7"),
        new Type("audits", "Audits due", "Audits", false, false, List.of("asof"), "asof"),
        new Type("infra", "Infrastructure health", "Infrastructure", false, false, List.of("asof"), "asof"),
        new Type("eventwork", "Event work", "Events", false, false, List.of("next7", "next14", "today_tomorrow"), "next7"));
    public static Type type(String id) { return TYPES.stream().filter((t) -> t.id().equals(id)).findFirst().orElse(null); }

    static final Map<String, String> PERIOD_LABELS = Map.ofEntries(Map.entry("today", "Today"), Map.entry("tomorrow", "Tomorrow"), Map.entry("today_tomorrow", "Today and tomorrow"),
        Map.entry("yesterday", "Yesterday"), Map.entry("next7", "Next 7 days"), Map.entry("next14", "Next 14 days"), Map.entry("last7", "Last 7 days"), Map.entry("last30", "Last 30 days"),
        Map.entry("mtd", "This month so far"), Map.entry("prevMonth", "Last month"), Map.entry("asof", "As of now"));
    public static Range range(Type t, String period, LocalDate today) {
        String p = period != null && PERIOD_LABELS.containsKey(period) ? period : t.defaultPeriod();
        LocalDate ms = today.withDayOfMonth(1);
        LocalDate[] r = switch (p) {
            case "tomorrow" -> new LocalDate[] {today.plusDays(1), today.plusDays(1)};
            case "today_tomorrow" -> new LocalDate[] {today, today.plusDays(1)};
            case "yesterday" -> new LocalDate[] {today.minusDays(1), today.minusDays(1)};
            case "next7" -> new LocalDate[] {today, today.plusDays(7)};
            case "next14" -> new LocalDate[] {today, today.plusDays(14)};
            case "last7" -> new LocalDate[] {today.minusDays(6), today};
            case "last30" -> new LocalDate[] {today.minusDays(29), today};
            case "mtd" -> new LocalDate[] {ms, today};
            case "prevMonth" -> new LocalDate[] {ms.minusMonths(1), ms.minusDays(1)};
            default -> new LocalDate[] {today, today};
        };
        return new Range(p, PERIOD_LABELS.get(p), r[0], r[1]);
    }

    // ---- the rows each report is built from -----------------------------------------------------------------------------------------------------
    public record BookingRow(LocalDate date, String slot, String amenity, UUID unitId, String unitNo, String status, String paymentStatus, BigDecimal base, BigDecimal gst, BigDecimal fee) {}
    public record DueRow(UUID unitId, String unitNo, String category, LocalDate billedMonth, BigDecimal outstanding, BigDecimal tax, LocalDate dueDate) {}
    public record PaymentRow(LocalDate paidOn, String unitNo, String kinds, BigDecimal amount, String method) {}
    public record PlantRow(LocalDate date, BigDecimal bh, BigDecimal wtp, BigDecimal stp, BigDecimal salt, BigDecimal chlorine, String remarks) {}
    public record TaskRow(String number, String title, String category, String priority, String status, String assignee, Instant slaDueAt, Instant createdAt, Instant closedAt) {}
    public record AuditRow(String area, LocalDate auditDate, String result, BigDecimal score, LocalDate nextDue) {}
    public record InfraRow(String name, String type, String area, String condition, Integer quantity, Integer faulty, String openTask) {}
    public record WorkRow(LocalDate neededOn, String eventName, String title, String phase, BigDecimal requested, BigDecimal confirmed, String staffType, String ownerRole, String status) {}

    static final DateTimeFormatter DMY = DateTimeFormatter.ofPattern("dd MMM yyyy", Locale.ENGLISH);
    public static String dmy(LocalDate d) { return d == null ? "" : DMY.format(d); }
    public static String inr(BigDecimal v) { NumberFormat f = NumberFormat.getIntegerInstance(Locale.forLanguageTag("en-IN")); return "₹" + f.format(v == null ? BigDecimal.ZERO : v.setScale(0, RoundingMode.HALF_UP)); }
    static BigDecimal z(BigDecimal v) { return v == null ? BigDecimal.ZERO : v; }
    static String plural(long n, String one) { return n + " " + one + (n == 1 ? "" : "s"); }
    static boolean in(LocalDate d, Range r) { return d != null && !d.isBefore(r.from()) && !d.isAfter(r.to()); }
    static <T> String byKey(List<T> rows, java.util.function.Function<T, String> key, java.util.function.Function<T, BigDecimal> value, boolean money) {
        Map<String, BigDecimal> m = new LinkedHashMap<>();
        for (T r : rows) m.merge(Objects.requireNonNullElse(key.apply(r), "—"), value.apply(r), BigDecimal::add);
        String s = m.entrySet().stream().sorted((a, b) -> b.getValue().compareTo(a.getValue())).map((e) -> e.getKey() + " " + (money ? inr(e.getValue()) : e.getValue().stripTrailingZeros().toPlainString()))
            .collect(Collectors.joining(", "));
        return s.isEmpty() ? "—" : s;
    }
    static Report report(String type, String title, List<String> lines, List<String> columns, List<List<Object>> rows, boolean empty, Set<String> tax, Set<String> money) {
        return new Report(type, title, lines, columns, rows, empty, null, null, null, null, tax, money);
    }

    public static Report bookings(List<BookingRow> all, Range r, String unitNo) {
        List<BookingRow> live = all.stream().filter((b) -> !"Cancelled".equals(b.status()) && in(b.date(), r)).sorted(Comparator.comparing(BookingRow::date).thenComparing((b) -> Objects.requireNonNullElse(b.slot(), ""))).toList();
        long cancelled = all.stream().filter((b) -> "Cancelled".equals(b.status()) && in(b.date(), r)).count(), pending = live.stream().filter((b) -> "Pending".equals(b.paymentStatus())).count();
        List<String> lines = new ArrayList<>(List.of(plural(live.size(), "booking") + (cancelled > 0 ? " · " + cancelled + " cancelled" : "") + (pending > 0 ? " · " + pending + " payment pending" : "")));
        if (unitNo == null && !live.isEmpty()) lines.add("By amenity: " + byKey(live, BookingRow::amenity, (b) -> BigDecimal.ONE, false));
        return report("bookings", unitNo == null ? "Amenity bookings" : "Your bookings · " + unitNo, lines, List.of("Date", "Time", "Amenity", "Unit", "Payment", "Taxable (₹)", "GST (₹)", "Fee (₹)"),
            live.stream().map((b) -> List.<Object>of(dmy(b.date()), s(b.slot()), s(b.amenity()), s(b.unitNo()), s(b.paymentStatus()), z(b.base()), z(b.gst()), z(b.fee()))).toList(), live.isEmpty(),
            Set.of("Taxable (₹)", "GST (₹)"), Set.of("Taxable (₹)", "GST (₹)", "Fee (₹)"));
    }
    public static Report dues(List<DueRow> unpaid, LocalDate today, String unitNo) {
        java.util.function.Predicate<DueRow> late = (d) -> d.dueDate() != null && d.dueDate().isBefore(today);
        BigDecimal total = unpaid.stream().map(DueRow::outstanding).reduce(BigDecimal.ZERO, BigDecimal::add), lateAmt = unpaid.stream().filter(late).map(DueRow::outstanding).reduce(BigDecimal.ZERO, BigDecimal::add);
        List<String> lines = new ArrayList<>(List.of("Outstanding " + inr(total) + " in " + plural(unpaid.size(), "bill") + (unitNo == null ? " from " + unpaid.stream().map(DueRow::unitId).distinct().count() + " units" : "")
            + " · overdue " + inr(lateAmt)));
        if (unitNo == null) lines.add("By kind: " + byKey(unpaid, DueRow::category, DueRow::outstanding, true));
        List<DueRow> sorted = unpaid.stream().sorted(Comparator.comparing((DueRow d) -> late.test(d) ? 0 : 1).thenComparing(DueRow::outstanding, Comparator.reverseOrder())).limit(500).toList();
        return report("dues", unitNo == null ? "Dues outstanding" : "Your dues · " + unitNo, lines, List.of("Unit", "Kind", "Month", "Amount (₹)", "Tax (₹)", "Payable by", "Status"),
            sorted.stream().map((d) -> List.<Object>of(s(d.unitNo()), s(d.category()), d.billedMonth() == null ? "" : d.billedMonth().getMonth().getDisplayName(TextStyle.SHORT, Locale.ENGLISH) + " " + d.billedMonth().getYear(),
                d.outstanding(), z(d.tax()), dmy(d.dueDate()), late.test(d) ? "Overdue" : "Unpaid")).toList(), unpaid.isEmpty(), Set.of("Tax (₹)"), Set.of("Amount (₹)", "Tax (₹)"));
    }
    public static Report collections(List<PaymentRow> paid) {
        BigDecimal total = paid.stream().map(PaymentRow::amount).reduce(BigDecimal.ZERO, BigDecimal::add);
        List<String> lines = List.of("Received " + inr(total) + " from " + plural(paid.size(), "payment"), "By kind: " + byKey(paid, PaymentRow::kinds, PaymentRow::amount, true),
            "By mode: " + byKey(paid, PaymentRow::method, PaymentRow::amount, true));
        return report("collections", "Payments received", lines, List.of("Paid on", "Unit", "Kind", "Amount (₹)", "Mode"),
            paid.stream().sorted(Comparator.comparing(PaymentRow::paidOn)).limit(500).map((p) -> List.<Object>of(dmy(p.paidOn()), s(p.unitNo()), s(p.kinds()), p.amount(), s(p.method()))).toList(),
            paid.isEmpty(), Set.of(), Set.of("Amount (₹)"));
    }
    public static Report water(List<PlantRow> logs) {
        java.util.function.Function<java.util.function.Function<PlantRow, BigDecimal>, BigDecimal> sum = (f) -> logs.stream().map(f).map(Reports::z).reduce(BigDecimal.ZERO, BigDecimal::add);
        int n = Math.max(logs.size(), 1);
        BigDecimal bh = sum.apply(PlantRow::bh);
        List<String> lines = List.of(plural(logs.size(), "day") + " logged",
            "Bhagiratha " + r0(bh) + " KL (avg " + r0(bh.divide(BigDecimal.valueOf(n), 2, RoundingMode.HALF_UP)) + "/day) · WTP " + r0(sum.apply(PlantRow::wtp)) + " KL · STP " + r0(sum.apply(PlantRow::stp)) + " KL",
            "Salt used " + r0(sum.apply(PlantRow::salt)) + " kg · Chlorine used " + sum.apply(PlantRow::chlorine).setScale(1, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString() + " L");
        return report("water", "Water & plant log", lines, List.of("Date", "Bhagiratha (KL)", "WTP (KL)", "STP (KL)", "Salt (kg)", "Chlorine (L)", "Remarks"),
            logs.stream().sorted(Comparator.comparing(PlantRow::date)).map((l) -> List.<Object>of(dmy(l.date()), o(l.bh()), o(l.wtp()), o(l.stp()), o(l.salt()), o(l.chlorine()), s(l.remarks()))).toList(),
            logs.isEmpty(), Set.of(), Set.of());
    }
    static final Set<String> CLOSED = Set.of("Completed", "Closed", "Cancelled");
    public static Report tasks(List<TaskRow> all, Range r, LocalDate today, ZoneId zone) {
        List<TaskRow> open = all.stream().filter((t) -> !CLOSED.contains(t.status())).toList();
        java.util.function.Predicate<TaskRow> late = (t) -> t.slaDueAt() != null && t.slaDueAt().atZone(zone).toLocalDate().isBefore(today);
        long raised = all.stream().filter((t) -> t.createdAt() != null && in(t.createdAt().atZone(zone).toLocalDate(), r)).count();
        long done = all.stream().filter((t) -> CLOSED.contains(t.status()) && t.closedAt() != null && in(t.closedAt().atZone(zone).toLocalDate(), r)).count();
        long lateN = open.stream().filter(late).count();
        List<String> lines = List.of(open.size() + " open · " + lateN + " past their due date · " + raised + " raised and " + done + " closed in the period",
            "Open by category: " + byKey(open, (t) -> t.category() == null ? "Other" : t.category(), (t) -> BigDecimal.ONE, false));
        List<TaskRow> listed = new ArrayList<>(open.stream().filter(late).toList()); listed.addAll(open.stream().filter(late.negate()).toList());
        return report("tasks", "Maintenance tasks", lines, List.of("Task", "Title", "Category", "Priority", "Status", "Assigned to", "Due", ""),
            listed.stream().limit(300).map((t) -> List.<Object>of(s(t.number()), s(t.title()), s(t.category()), s(t.priority()), s(t.status()), t.assignee() == null ? "Unassigned" : t.assignee(),
                t.slaDueAt() == null ? "" : dmy(t.slaDueAt().atZone(zone).toLocalDate()), late.test(t) ? "Late" : "")).toList(), open.isEmpty() && raised == 0 && done == 0, Set.of(), Set.of());
    }
    public static Report audits(List<AuditRow> all, LocalDate today) {
        Map<String, AuditRow> latest = new LinkedHashMap<>();
        for (AuditRow a : all) latest.merge(a.area(), a, (x, y) -> y.auditDate() != null && (x.auditDate() == null || y.auditDate().isAfter(x.auditDate())) ? y : x);
        record S(AuditRow a, Long d, String state) {}
        List<S> rows = latest.values().stream().map((a) -> {
            Long d = a.nextDue() == null ? null : ChronoUnit.DAYS.between(today, a.nextDue());
            String st = d == null ? "No next date" : d < 0 ? "Overdue by " + plural(-d, "day") : d <= 30 ? "Due in " + plural(d, "day") : "OK";
            return new S(a, d, st);
        }).sorted(Comparator.comparing((S x) -> x.d() == null ? 9999L : x.d())).toList();
        long od = rows.stream().filter((x) -> x.d() != null && x.d() < 0).count(), soon = rows.stream().filter((x) -> x.d() != null && x.d() >= 0 && x.d() <= 30).count();
        long fail = rows.stream().filter((x) -> "Fail".equals(x.a().result())).count();
        return report("audits", "Audits due", List.of(rows.size() + " areas audited · " + od + " overdue · " + soon + " due in 30 days · " + fail + " last audit failed"),
            List.of("Area", "Last audit", "Result", "Score", "Next due", "State"),
            rows.stream().map((x) -> List.<Object>of(s(x.a().area()), dmy(x.a().auditDate()), s(x.a().result()), o(x.a().score()), dmy(x.a().nextDue()), x.state())).toList(), rows.isEmpty(), Set.of(), Set.of());
    }
    public static Report infra(List<InfraRow> needing) {
        java.util.function.Function<String, Long> cnt = (c) -> needing.stream().filter((x) -> c.equals(x.condition())).count();
        List<InfraRow> sorted = needing.stream().sorted(Comparator.comparing((InfraRow x) -> "Out of service".equals(x.condition()) ? 0 : 1)).toList();
        return report("infra", "Infrastructure health", List.of(plural(needing.size(), "asset") + " need action: " + cnt.apply("Out of service") + " out of service · " + cnt.apply("Under repair")
                + " under repair · " + cnt.apply("Needs attention") + " need attention"), List.of("Asset", "Kind", "Area", "Condition", "Faulty", "Open task"),
            sorted.stream().map((x) -> List.<Object>of(s(x.name()), s(x.type()), s(x.area()), s(x.condition()), x.quantity() != null && x.quantity() > 1 ? (x.faulty() == null ? 0 : x.faulty()) + " of " + x.quantity() : "",
                s(x.openTask()))).toList(), needing.isEmpty(), Set.of(), Set.of());
    }
    public static Report eventWork(List<WorkRow> pending, Range r, LocalDate today) {
        List<WorkRow> late = pending.stream().filter((w) -> w.neededOn() != null && w.neededOn().isBefore(today)).toList(), soon = pending.stream().filter((w) -> in(w.neededOn(), r)).toList();
        List<WorkRow> list = new ArrayList<>(late); list.addAll(soon.stream().filter((w) -> !late.contains(w)).toList());
        list.sort(Comparator.comparing(WorkRow::neededOn, Comparator.nullsLast(Comparator.naturalOrder())));
        BigDecimal need = soon.stream().map(WorkRow::requested).map(Reports::z).reduce(BigDecimal.ZERO, BigDecimal::add), got = soon.stream().map(WorkRow::confirmed).map(Reports::z).reduce(BigDecimal.ZERO, BigDecimal::add);
        java.util.function.Function<String, Long> own = (role) -> list.stream().filter((w) -> role.equals(w.ownerRole())).count();
        return report("eventwork", "Event work", List.of(plural(list.size(), "item") + " to do: " + late.size() + " late · Facility Manager " + own.apply("Facility Manager") + " · MEP " + own.apply("MEP"),
                "People needed " + r0(need) + " · confirmed " + r0(got) + (need.compareTo(got) > 0 ? " · " + r0(need.subtract(got)) + " still to arrange" : "")),
            List.of("Needed on", "Event", "Work", "When", "People", "Kind", "Owner", "Status"),
            list.stream().map((w) -> List.<Object>of(dmy(w.neededOn()), s(w.eventName()), s(w.title()), s(w.phase()), r0(z(w.confirmed())) + "/" + r0(z(w.requested())), s(w.staffType()), s(w.ownerRole()), s(w.status()))).toList(),
            list.isEmpty(), Set.of(), Set.of());
    }

    // ---- what a schedule shows ------------------------------------------------------------------------------------------------------------------
    public record Show(List<String> columns, boolean tax, boolean totals, boolean summary, String intro, String footer) {
        public static final Show ALL = new Show(List.of(), true, false, true, null, null);
    }
    public static Report shape(Report r, Type t, Show o, Range range, LocalDate today) {
        List<Integer> idx = new ArrayList<>();
        for (int i = 0; i < r.columns().size(); i++) {
            String c = r.columns().get(i);
            boolean keep = !(t.taxAware() && !o.tax() && r.taxCols().contains(c)) && (o.columns().isEmpty() || o.columns().contains(c));
            if (keep) idx.add(i);
        }
        if (idx.isEmpty()) for (int i = 0; i < r.columns().size(); i++) idx.add(i);
        List<String> cols = idx.stream().map(r.columns()::get).toList();
        List<List<Object>> rows = new ArrayList<>(r.rows().stream().map((row) -> idx.stream().map(row::get).toList()).toList());
        if (o.totals() && !rows.isEmpty() && cols.stream().anyMatch(r.moneyCols()::contains)) {
            List<Object> tot = new ArrayList<>();
            for (int j = 0; j < cols.size(); j++) {
                final int k = j;
                if (j == 0) tot.add("Total");
                else if (r.moneyCols().contains(cols.get(j))) tot.add(rows.stream().map((x) -> x.get(k) instanceof BigDecimal b ? b : BigDecimal.ZERO).reduce(BigDecimal.ZERO, BigDecimal::add).setScale(2, RoundingMode.HALF_UP));
                else tot.add("");
            }
            rows.add(tot);
        }
        String label = t.periods().size() > 1 || !"asof".equals(range.id()) ? range.label() : null;
        return new Report(r.type(), r.title(), o.summary() ? r.lines() : List.of(), cols, List.copyOf(rows), r.empty(), label, today, range.from(), range.to(), r.taxCols(), r.moneyCols());
    }
    /** The text of a report as sent in a message. */
    public static String text(Report r, String format, String community, Show o) {
        List<String> out = new ArrayList<>();
        out.add("*" + (community == null || community.isBlank() ? "" : community + " · ") + r.title() + "*" + (r.periodLabel() == null ? "" : " · " + r.periodLabel()) + " · " + dmy(r.today()));
        if (o.intro() != null && !o.intro().isBlank()) { out.add(""); out.add(o.intro()); }
        out.add(""); out.addAll(r.lines());
        if ("Detailed".equals(format) && !r.rows().isEmpty()) {
            out.add("");
            r.rows().stream().limit(25).forEach((row) -> out.add("• " + row.stream().map(Reports::cell).filter((x) -> !x.isEmpty()).collect(Collectors.joining(" · "))));
            if (r.rows().size() > 25) out.add("…and " + (r.rows().size() - 25) + " more (see Reports → Sent)");
        } else if (("Excel".equals(format) || "CSV".equals(format)) && !r.rows().isEmpty()) {
            out.add(""); out.add("Full table (" + r.rows().size() + " lines) is in Reports → Sent as " + ("Excel".equals(format) ? "an Excel file" : "a CSV file") + ".");
        }
        if (r.empty()) { out.add(""); out.add("Nothing to report."); }
        if (o.footer() != null && !o.footer().isBlank()) { out.add(""); out.add(o.footer()); }
        return String.join("\n", out);
    }
    static String cell(Object x) {
        if (x instanceof BigDecimal b) { NumberFormat f = NumberFormat.getNumberInstance(Locale.forLanguageTag("en-IN")); f.setMaximumFractionDigits(2); return f.format(b); }
        return x == null ? "" : x.toString();
    }

    /** The key of the run due now ("" when none): a schedule runs once a day / on its weekday / on its day of the month, from its time. */
    public static String dueKey(boolean active, String frequency, LocalTime time, String weekday, Integer monthDay, String lastRunKey, ZonedDateTime now) {
        if (!active) return "";
        if (now.toLocalTime().isBefore(time == null ? LocalTime.of(8, 0) : time)) return "";
        LocalDate today = now.toLocalDate();
        if ("Weekly".equals(frequency) && now.getDayOfWeek() != DayOfWeek.valueOf((weekday == null ? "Monday" : weekday).toUpperCase(Locale.ROOT))) return "";
        if ("Monthly".equals(frequency) && today.getDayOfMonth() != Math.min(monthDay == null ? 1 : monthDay, today.lengthOfMonth())) return "";
        String key = today.toString();
        return key.equals(lastRunKey) ? "" : key;
    }

    static String s(String v) { return v == null ? "" : v; }
    static Object o(BigDecimal v) { return v == null ? "" : v; }
    static String r0(BigDecimal v) { return z(v).setScale(0, RoundingMode.HALF_UP).toPlainString(); }
}
