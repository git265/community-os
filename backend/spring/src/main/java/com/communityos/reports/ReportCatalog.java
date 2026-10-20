package com.communityos.reports;

import com.communityos.amenities.AmenityEngine;
import com.communityos.amenities.IcuCompare;
import com.communityos.finance.FinDates;
import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * The reports a community can schedule: each is a small function over the community's own data that returns a title, summary lines and a table. A port of
 * src/lib/reports/catalog.js (the eight built-in reports, the custom report built from a stored recipe, the column / total shaping and the text of a message).
 * Held equal to the JavaScript by ReportsConformanceCheck.
 *
 * A table cell is what JavaScript would hold: a String, a Double, a Boolean, a JsonNode (a list or an object taken from the data) or null (undefined / null).
 */
public final class ReportCatalog {
    private ReportCatalog() {}

    // ---- the shapes ---------------------------------------------------------------------------------------------------

    public record Range(String id, String label, String from, String to) {}

    /** What one report build returns (and, after buildReport, what a message is made of). */
    public static final class Rep {
        public String title = "", report = "", periodLabel = "", today = "", intro = "", footer = "";
        public List<String> lines = new ArrayList<>(), columns = new ArrayList<>(), taxCols = new ArrayList<>(), moneyCols = new ArrayList<>();
        public List<List<Object>> rows = new ArrayList<>();
        public boolean empty;
        Range range;
    }

    /** One entry of the catalog. */
    public record Def(String id, String label, boolean perUnit, boolean taxAware, List<String> needs, List<String> periods, String defaultPeriod, Builder build) {}

    public interface Builder { Rep build(Map<String, List<JsonNode>> data, Range range, String today, String unit); }

    /** What a schedule chose to show: which columns, tax columns, a totals row, a summary, an intro and a footer. */
    public record Opts(List<String> columns, boolean tax, boolean totals, boolean summary, String intro, String footer) {}

    public static Opts optsOf(JsonNode s) {
        List<String> cols = new ArrayList<>();
        JsonNode sc = Js.f(s, "showCols");
        if (sc.isArray()) for (JsonNode c : sc) cols.add(Js.toStr(c));
        return new Opts(cols, !(Js.f(s, "showTax").isBoolean() && !Js.f(s, "showTax").asBoolean()), Js.truthy(s, "showTotals"), !(Js.f(s, "showSummary").isBoolean() && !Js.f(s, "showSummary").asBoolean()),
                Js.orEmpty(Js.f(s, "intro")), Js.orEmpty(Js.f(s, "footer")));
    }

    // ---- periods -------------------------------------------------------------------------------------------------------

    private static final Map<String, String> PERIOD_LABEL = new LinkedHashMap<>();
    static {
        PERIOD_LABEL.put("today", "Today"); PERIOD_LABEL.put("tomorrow", "Tomorrow"); PERIOD_LABEL.put("today_tomorrow", "Today and tomorrow"); PERIOD_LABEL.put("yesterday", "Yesterday");
        PERIOD_LABEL.put("next7", "Next 7 days"); PERIOD_LABEL.put("next14", "Next 14 days"); PERIOD_LABEL.put("last7", "Last 7 days"); PERIOD_LABEL.put("last30", "Last 30 days");
        PERIOD_LABEL.put("mtd", "This month so far"); PERIOD_LABEL.put("prevMonth", "Last month"); PERIOD_LABEL.put("asof", "As of now");
    }
    public static List<String> periodIds() { return new ArrayList<>(PERIOD_LABEL.keySet()); }

    private static String monthStart(String s) { return (s.length() > 7 ? s.substring(0, 7) : s) + "-01"; }

    static Range rangeFor(Def def, String periodId, String t) {
        String p = periodId != null && PERIOD_LABEL.containsKey(periodId) ? periodId : def.defaultPeriod();
        String from, to;
        switch (p) {
            case "today", "asof" -> { from = t; to = t; }
            case "tomorrow" -> { from = FinDates.addDays(t, 1); to = from; }
            case "today_tomorrow" -> { from = t; to = FinDates.addDays(t, 1); }
            case "yesterday" -> { from = FinDates.addDays(t, -1); to = from; }
            case "next7" -> { from = t; to = FinDates.addDays(t, 7); }
            case "next14" -> { from = t; to = FinDates.addDays(t, 14); }
            case "last7" -> { from = FinDates.addDays(t, -6); to = t; }
            case "last30" -> { from = FinDates.addDays(t, -29); to = t; }
            case "mtd" -> { from = monthStart(t); to = t; }
            default -> { String lastOfPrev = FinDates.addDays(monthStart(t), -1); from = monthStart(lastOfPrev); to = lastOfPrev; }   // prevMonth
        }
        return new Range(p, PERIOD_LABEL.get(p), from, to);
    }

    // ---- small helpers -------------------------------------------------------------------------------------------------

    private static JsonNode f(JsonNode r, String k) { return Js.f(r, k); }
    private static String s(JsonNode n) { return Js.toStr(n); }

    /** A value as a table cell. */
    static Object cell(JsonNode n) {
        if (n == null || n.isMissingNode() || n.isNull()) return null;
        if (n.isTextual()) return n.asText();
        if (n.isNumber()) return n.asDouble();
        if (n.isBoolean()) return n.asBoolean();
        return n;
    }
    private static Object or(JsonNode n, Object dflt) { return Js.truthy(n) ? cell(n) : dflt; }
    private static Object nn(JsonNode n, Object dflt) { return n == null || n.isMissingNode() || n.isNull() ? dflt : cell(n); }
    private static double nz(JsonNode r, String k) { return Js.number(r, k); }
    private static String plural(int n, String one, String many) { return n == 1 ? one : many; }
    private static List<Object> row(Object... cells) { List<Object> r = new ArrayList<>(); Collections.addAll(r, cells); return r; }
    private static double jsRound(double x) { return AmenityEngine.jsRound(x); }
    private static String num(double d) { return Js.numberToString(d); }

    /** between(): the day of d (its first ten characters) lies in the range. */
    private static boolean between(JsonNode d, Range r) {
        if (!Js.truthy(d)) return false;
        String t = s(d); t = t.length() > 10 ? t.substring(0, 10) : t;
        return t.compareTo(r.from()) >= 0 && t.compareTo(r.to()) <= 0;
    }
    private static boolean closed(JsonNode t) { return Js.is(t, "status", "Completed") || Js.is(t, "status", "Closed") || Js.is(t, "status", "Cancelled"); }

    private static List<JsonNode> where(List<JsonNode> in, java.util.function.Predicate<JsonNode> p) { List<JsonNode> out = new ArrayList<>(); for (JsonNode x : in) if (p.test(x)) out.add(x); return out; }
    private static List<JsonNode> data(Map<String, List<JsonNode>> d, String c) { List<JsonNode> l = d.get(c); return l == null ? List.of() : l; }

    /** `String(a).localeCompare(String(b))` on the text of two values. */
    private static int icu(String a, String b) { return IcuCompare.compare(a, b); }

    /** A Map keyed the way JavaScript's Map is (the value, not its text). */
    private static void bump(Map<JsonNode, double[]> m, JsonNode key, double by) { m.computeIfAbsent(key, k -> new double[1])[0] += by; }   // undefined (MISSING) and null are different keys, as in a JavaScript Map }

    private static String joinPairs(List<Map.Entry<JsonNode, double[]>> es, Function<Double, String> fmt) {
        List<String> parts = new ArrayList<>();
        for (Map.Entry<JsonNode, double[]> e : es) parts.add(s(e.getKey()) + " " + fmt.apply(e.getValue()[0]));
        return String.join(", ", parts);
    }

    // ---- the built-in reports --------------------------------------------------------------------------------------------

    private static Rep bookings(Map<String, List<JsonNode>> d, Range range, String today, String unit) {
        List<JsonNode> all = where(data(d, "amenities"), b -> unit.isEmpty() || Js.strictEq(f(b, "unit"), com.fasterxml.jackson.databind.node.TextNode.valueOf(unit)));
        List<JsonNode> live = where(all, b -> !Js.is(b, "status", "Cancelled") && between(f(b, "date"), range));
        live.sort((a, b) -> icu(s(f(a, "date")) + " " + s(f(a, "slot")), s(f(b, "date")) + " " + s(f(b, "slot"))));
        int cancelled = where(all, b -> Js.is(b, "status", "Cancelled") && between(f(b, "date"), range)).size();
        int pending = where(live, b -> Js.is(b, "paymentStatus", "Pending")).size();
        Rep r = new Rep();
        r.lines.add(live.size() + " booking" + plural(live.size(), "", "s") + (cancelled > 0 ? " · " + cancelled + " cancelled" : "") + (pending > 0 ? " · " + pending + " payment pending" : ""));
        Map<JsonNode, double[]> byAm = new LinkedHashMap<>();
        for (JsonNode b : live) bump(byAm, f(b, "amenity"), 1);
        if (unit.isEmpty() && !byAm.isEmpty()) r.lines.add("By amenity: " + joinPairs(new ArrayList<>(byAm.entrySet()), v -> num(v)));
        r.title = !unit.isEmpty() ? "Your bookings · " + unit : "Amenity bookings";
        r.columns = List.of("Date", "Time", "Amenity", "Unit", "Payment", "Taxable (₹)", "GST (₹)", "Fee (₹)");
        r.taxCols = List.of("Taxable (₹)", "GST (₹)");
        r.moneyCols = List.of("Taxable (₹)", "GST (₹)", "Fee (₹)");
        for (JsonNode b : live) r.rows.add(row(FinDates.dmy(f(b, "date")), or(f(b, "slot"), ""), cell(f(b, "amenity")), cell(f(b, "unit")), or(f(b, "paymentStatus"), ""), nz(b, "baseAmount"), nz(b, "gstAmount"), nz(b, "feeTotal")));
        r.empty = live.isEmpty();
        return r;
    }

    /** `late(d)` as a number, the way `late(b) - late(a)` reads it: the due date itself when there is none ('' is 0, undefined is NaN), else 1 or 0. */
    private static double lateNum(JsonNode d, String today) {
        JsonNode due = f(d, "dueDate");
        if (!Js.truthy(due)) return due.isMissingNode() ? Double.NaN : Js.toNumber(due) == 0 || due.isNull() ? 0 : Js.toNumber(due);
        return due.isTextual() && due.asText().compareTo(today) < 0 ? 1 : 0;
    }

    private static Rep dues(Map<String, List<JsonNode>> d, Range range, String today, String unit) {
        List<JsonNode> unpaid = where(data(d, "dues"), x -> !Js.is(x, "status", "Paid") && !Js.is(x, "status", "Cancelled") && nz(x, "amount") > 0 && (unit.isEmpty() || Js.is(x, "unit", unit)));
        java.util.function.Predicate<JsonNode> late = x -> lateNum(x, today) == 1 && Js.truthy(x, "dueDate");
        double total = 0, lateAmt = 0;
        for (JsonNode x : unpaid) total += Js.toNumber(f(x, "amount"));
        for (JsonNode x : unpaid) if (late.test(x)) lateAmt += Js.toNumber(f(x, "amount"));
        Rep r = new Rep();
        Set<JsonNode> units = new LinkedHashSet<>();
        for (JsonNode x : unpaid) units.add(f(x, "unit"));
        r.lines.add("Outstanding " + FinDates.inr(total) + " in " + unpaid.size() + " bill" + plural(unpaid.size(), "", "s") + (!unit.isEmpty() ? "" : " from " + units.size() + " units") + " · overdue " + FinDates.inr(lateAmt));
        if (unit.isEmpty()) {
            Map<JsonNode, double[]> cat = new LinkedHashMap<>();
            for (JsonNode x : unpaid) bump(cat, f(x, "category"), Js.toNumber(f(x, "amount")));
            List<Map.Entry<JsonNode, double[]>> es = new ArrayList<>(cat.entrySet());
            es.sort((a, b) -> Double.compare(b.getValue()[0], a.getValue()[0]));
            r.lines.add("By kind: " + joinPairs(es, v -> FinDates.inr(v)));
        }
        List<JsonNode> sorted = new ArrayList<>(unpaid);
        sorted.sort((a, b) -> {
            double x = lateNum(b, today) - lateNum(a, today);
            if (x != 0 && !Double.isNaN(x)) return x < 0 ? -1 : 1;
            double y = Js.toNumber(f(b, "amount")) - Js.toNumber(f(a, "amount"));
            return y < 0 ? -1 : y > 0 ? 1 : 0;
        });
        r.title = !unit.isEmpty() ? "Your dues · " + unit : "Dues outstanding";
        r.columns = List.of("Unit", "Kind", "Month", "Amount (₹)", "Tax (₹)", "Payable by", "Status");
        r.taxCols = List.of("Tax (₹)");
        r.moneyCols = List.of("Amount (₹)", "Tax (₹)");
        for (JsonNode x : sorted.subList(0, Math.min(500, sorted.size())))
            r.rows.add(row(cell(f(x, "unit")), cell(f(x, "category")), or(f(x, "billedMonth"), ""), Js.toNumber(f(x, "amount")), nz(x, "tax"), FinDates.dmy(f(x, "dueDate")), late.test(x) ? "Overdue" : "Unpaid"));
        r.empty = unpaid.isEmpty();
        return r;
    }

    private static Rep collections(Map<String, List<JsonNode>> d, Range range, String today, String unit) {
        List<JsonNode> paid = where(data(d, "dues"), x -> Js.is(x, "status", "Paid") && between(f(x, "paidAt"), range));
        double total = 0;
        for (JsonNode x : paid) total += Js.toNumber(Js.truthy(x, "amount") ? f(x, "amount") : com.fasterxml.jackson.databind.node.IntNode.valueOf(0));
        Rep r = new Rep();
        r.lines.add("Received " + FinDates.inr(total) + " from " + paid.size() + " payment" + plural(paid.size(), "", "s"));
        for (String[] k : new String[][] {{"category", "By kind: "}, {"paymentMode", "By mode: "}}) {
            Map<JsonNode, double[]> m = new LinkedHashMap<>();
            for (JsonNode x : paid) bump(m, Js.truthy(x, k[0]) ? f(x, k[0]) : com.fasterxml.jackson.databind.node.TextNode.valueOf("—"), Js.toNumber(Js.truthy(x, "amount") ? f(x, "amount") : com.fasterxml.jackson.databind.node.IntNode.valueOf(0)));
            List<Map.Entry<JsonNode, double[]>> es = new ArrayList<>(m.entrySet());
            es.sort((a, b) -> Double.compare(b.getValue()[0], a.getValue()[0]));
            String text = joinPairs(es, v -> FinDates.inr(v));
            r.lines.add(k[1] + (text.isEmpty() ? "—" : text));
        }
        List<JsonNode> sorted = new ArrayList<>(paid);
        sorted.sort((a, b) -> icu(s(f(a, "paidAt")), s(f(b, "paidAt"))));
        r.title = "Payments received";
        r.columns = List.of("Paid on", "Unit", "Kind", "Month", "Amount (₹)", "Mode");
        r.moneyCols = List.of("Amount (₹)");
        for (JsonNode x : sorted.subList(0, Math.min(500, sorted.size())))
            r.rows.add(row(FinDates.dmy(f(x, "paidAt")), cell(f(x, "unit")), cell(f(x, "category")), or(f(x, "billedMonth"), ""), Js.toNumber(f(x, "amount")), or(f(x, "paymentMode"), "")));
        r.empty = paid.isEmpty();
        return r;
    }

    private static Rep water(Map<String, List<JsonNode>> d, Range range, String today, String unit) {
        List<JsonNode> logs = where(data(d, "plantLogs"), l -> between(f(l, "date"), range));
        logs.sort((a, b) -> icu(s(f(a, "date")), s(f(b, "date"))));
        java.util.function.Function<String, Double> sum = k -> { double t = 0; for (JsonNode l : logs) t += nz(l, k); return t; };
        double n = logs.isEmpty() ? 1 : logs.size();
        Rep r = new Rep();
        r.lines.add(logs.size() + " day" + plural(logs.size(), "", "s") + " logged");
        r.lines.add("Bhagiratha " + num(jsRound(sum.apply("bhKl"))) + " KL (avg " + num(jsRound(sum.apply("bhKl") / n)) + "/day) · WTP " + num(jsRound(sum.apply("wtpKl"))) + " KL · STP " + num(jsRound(sum.apply("stpKl"))) + " KL");
        r.lines.add("Salt used " + num(jsRound(sum.apply("saltUsed"))) + " kg · Chlorine used " + num(jsRound(sum.apply("chlorineUsed") * 10) / 10) + " L");
        r.title = "Water & plant log";
        r.columns = List.of("Date", "Bhagiratha (KL)", "WTP (KL)", "STP (KL)", "Salt (kg)", "Chlorine (L)", "Remarks");
        for (JsonNode l : logs) r.rows.add(row(FinDates.dmy(f(l, "date")), nn(f(l, "bhKl"), ""), nn(f(l, "wtpKl"), ""), nn(f(l, "stpKl"), ""), nn(f(l, "saltUsed"), ""), nn(f(l, "chlorineUsed"), ""), or(f(l, "remarks"), "")));
        r.empty = logs.isEmpty();
        return r;
    }

    private static Rep tasks(Map<String, List<JsonNode>> d, Range range, String today, String unit) {
        List<JsonNode> all = data(d, "tickets");
        List<JsonNode> open = where(all, t -> !closed(t));
        List<JsonNode> late = where(open, t -> Js.truthy(t, "slaDueAt") && (s(f(t, "slaDueAt")).length() > 10 ? s(f(t, "slaDueAt")).substring(0, 10) : s(f(t, "slaDueAt"))).compareTo(today) < 0);
        int raised = where(all, t -> between(f(t, "recordCreatedAt"), range)).size();
        int done = where(all, t -> closed(t) && between(f(t, "lastUpdatedAt"), range)).size();
        Rep r = new Rep();
        r.lines.add(open.size() + " open · " + late.size() + " past their due date · " + raised + " raised and " + done + " closed in the period");
        Map<JsonNode, double[]> by = new LinkedHashMap<>();
        for (JsonNode t : open) bump(by, Js.truthy(t, "category") ? f(t, "category") : com.fasterxml.jackson.databind.node.TextNode.valueOf("Other"), 1);
        List<Map.Entry<JsonNode, double[]>> es = new ArrayList<>(by.entrySet());
        es.sort((a, b) -> Double.compare(b.getValue()[0], a.getValue()[0]));
        String text = joinPairs(es.subList(0, Math.min(8, es.size())), v -> num(v));
        r.lines.add("Open by category: " + (text.isEmpty() ? "—" : text));
        Set<JsonNode> lateSet = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
        lateSet.addAll(late);
        List<JsonNode> ordered = new ArrayList<>(late);
        for (JsonNode t : open) if (!lateSet.contains(t)) ordered.add(t);
        r.title = "Maintenance tasks";
        r.columns = List.of("Task", "Title", "Category", "Priority", "Status", "Assigned to", "Due", "");
        for (JsonNode t : ordered.subList(0, Math.min(300, ordered.size())))
            r.rows.add(row(or(f(t, "ticketNumber"), ""), cell(f(t, "title")), or(f(t, "category"), ""), or(f(t, "priority"), ""), cell(f(t, "status")), or(f(t, "assignedTo"), "Unassigned"),
                    Js.truthy(t, "slaDueAt") ? FinDates.dmy(f(t, "slaDueAt")) : "", lateSet.contains(t) ? "Late" : ""));
        r.empty = open.isEmpty() && raised == 0 && done == 0;
        return r;
    }

    private record AuditRow(JsonNode a, Double days, String state) {}

    private static Rep audits(Map<String, List<JsonNode>> d, Range range, String today, String unit) {
        Map<JsonNode, JsonNode> latest = new LinkedHashMap<>();
        for (JsonNode a : data(d, "audits")) {
            JsonNode key = f(a, "area").isMissingNode() ? com.fasterxml.jackson.databind.node.NullNode.getInstance() : f(a, "area");
            JsonNode o = latest.get(key);
            if (o == null || s(f(a, "auditDate")).compareTo(s(f(o, "auditDate"))) > 0) latest.put(key, a);
        }
        List<AuditRow> rows = new ArrayList<>();
        for (JsonNode a : latest.values()) {
            Double days = Js.truthy(a, "nextDue") ? Double.valueOf(FinDates.daysBetween(today, s(f(a, "nextDue")))) : null;
            String state = days == null ? "No next date" : days < 0 ? "Overdue by " + num(-days) + " day" + (days == -1 ? "" : "s") : days <= 30 ? "Due in " + num(days) + " day" + (days == 1 ? "" : "s") : "OK";
            rows.add(new AuditRow(a, days, state));
        }
        rows.sort((x, y) -> {
            double dx = x.days() == null ? 9999 : x.days(), dy = y.days() == null ? 9999 : y.days();
            double diff = dx - dy;
            return diff < 0 ? -1 : diff > 0 ? 1 : 0;
        });
        int od = 0, soon = 0, fail = 0;
        for (AuditRow x : rows) {
            if (x.days() != null && x.days() < 0) od++;
            if (x.days() != null && x.days() >= 0 && x.days() <= 30) soon++;
            if (Js.is(x.a(), "result", "Fail")) fail++;
        }
        Rep r = new Rep();
        r.title = "Audits due";
        r.lines.add(rows.size() + " areas audited · " + od + " overdue · " + soon + " due in 30 days · " + fail + " last audit failed");
        r.columns = List.of("Area", "Last audit", "Result", "Score", "Next due", "State");
        for (AuditRow x : rows) r.rows.add(row(cell(f(x.a(), "area")), FinDates.dmy(f(x.a(), "auditDate")), cell(f(x.a(), "result")), nn(f(x.a(), "score"), ""), FinDates.dmy(f(x.a(), "nextDue")), x.state()));
        r.empty = rows.isEmpty();
        return r;
    }

    // infraModel.js: units, faultyOf, effectiveCondition, openTicketsByAsset
    private static double unitsOf(JsonNode a) { double q = nz(a, "quantity"); return Math.max(1, q != 0 ? q : 1); }
    private static double faultyOf(JsonNode a) { return Math.min(unitsOf(a), Math.max(0, nz(a, "faulty"))); }
    private static final List<String> CONDITIONS = List.of("Working", "Needs attention", "Under repair", "Out of service", "Standby", "Retired");
    private static String effectiveCondition(JsonNode a, Set<JsonNode> openIds) {
        if (Js.is(a, "status", "Standby") || Js.is(a, "status", "Retired")) return Js.str(f(a, "status"));
        if (openIds.contains(f(a, "id"))) return "Under repair";
        double fl = faultyOf(a);
        if (fl > 0 && unitsOf(a) > 1) return fl / unitsOf(a) >= 0.3 ? "Out of service" : "Needs attention";
        if (fl > 0 && Js.is(a, "status", "Working")) return "Needs attention";
        String st = Js.text(a, "status");
        return st != null && CONDITIONS.contains(st) ? st : "Working";
    }

    private static Rep infra(Map<String, List<JsonNode>> d, Range range, String today, String unit) {
        Map<JsonNode, List<JsonNode>> open = new LinkedHashMap<>();
        for (JsonNode t : data(d, "tickets")) {
            if (!Js.truthy(t, "assetId") || Js.is(t, "status", "Closed") || Js.is(t, "status", "Cancelled")) continue;
            open.computeIfAbsent(f(t, "assetId"), k -> new ArrayList<>()).add(t);
        }
        Set<JsonNode> openIds = open.keySet();
        List<Object[]> rows = new ArrayList<>();
        for (JsonNode a : data(d, "equipment")) {
            String c = effectiveCondition(a, openIds);
            if (c.equals("Needs attention") || c.equals("Under repair") || c.equals("Out of service")) rows.add(new Object[] {a, c});
        }
        int out = 0, rep = 0, att = 0;
        for (Object[] x : rows) { String c = (String) x[1]; if (c.equals("Out of service")) out++; if (c.equals("Under repair")) rep++; if (c.equals("Needs attention")) att++; }
        Rep r = new Rep();
        r.title = "Infrastructure health";
        r.lines.add(rows.size() + " asset" + plural(rows.size(), "", "s") + " need action: " + out + " out of service · " + rep + " under repair · " + att + " need attention");
        r.columns = List.of("Asset", "Kind", "Area", "Condition", "Faulty", "Open task");
        List<Object[]> sorted = new ArrayList<>(rows);
        sorted.sort((x, y) -> Integer.compare(x[1].equals("Out of service") ? 0 : 1, y[1].equals("Out of service") ? 0 : 1));
        for (Object[] x : sorted) {
            JsonNode a = (JsonNode) x[0];
            List<JsonNode> ts = open.get(f(a, "id"));
            Object ticket = ts == null || ts.isEmpty() ? "" : or(f(ts.get(0), "ticketNumber"), "");
            r.rows.add(row(cell(f(a, "name")), cell(f(a, "type")), or(f(a, "area"), ""), x[1], unitsOf(a) > 1 ? num(faultyOf(a)) + " of " + num(unitsOf(a)) : "", ticket));
        }
        r.empty = rows.isEmpty();
        return r;
    }

    private static boolean strLess(JsonNode a, String b) { return a.isTextual() && a.asText().compareTo(b) < 0; }

    private static Rep eventwork(Map<String, List<JsonNode>> d, Range range, String today, String unit) {
        List<JsonNode> pending = where(data(d, "eventWork"), w -> !Js.is(w, "status", "Done") && !Js.is(w, "status", "Cancelled"));
        List<JsonNode> late = where(pending, w -> strLess(f(w, "neededOn"), today));
        List<JsonNode> soon = where(pending, w -> between(f(w, "neededOn"), range));
        List<JsonNode> list = new ArrayList<>(late); list.addAll(soon);
        list.sort((a, b) -> icu(s(f(a, "neededOn")), s(f(b, "neededOn"))));
        double need = 0, got = 0;
        for (JsonNode w : soon) { need += nz(w, "staffRequested"); got += nz(w, "staffConfirmed"); }
        java.util.function.Function<String, Integer> own = role -> where(soon, w -> Js.is(w, "ownerRole", role)).size() + where(late, w -> Js.is(w, "ownerRole", role)).size();
        Rep r = new Rep();
        r.title = "Event work";
        r.lines.add(list.size() + " item" + plural(list.size(), "", "s") + " to do: " + late.size() + " late · Facility Manager " + own.apply("Facility Manager") + " · MEP " + own.apply("MEP"));
        r.lines.add("People needed " + num(need) + " · confirmed " + num(got) + (need > got ? " · " + num(need - got) + " still to arrange" : ""));
        r.columns = List.of("Needed on", "Event", "Work", "When", "People", "Kind", "Owner", "Status");
        for (JsonNode w : list)
            r.rows.add(row(FinDates.dmy(f(w, "neededOn")), cell(f(w, "eventName")), cell(f(w, "title")), cell(f(w, "phase")),
                    (Js.truthy(w, "staffConfirmed") ? s(f(w, "staffConfirmed")) : "0") + "/" + (Js.truthy(w, "staffRequested") ? s(f(w, "staffRequested")) : "0"),
                    or(f(w, "staffType"), ""), cell(f(w, "ownerRole")), cell(f(w, "status"))));
        r.empty = list.isEmpty();
        return r;
    }

    public static final List<Def> REPORTS = List.of(
            new Def("bookings", "Amenity bookings", true, true, List.of("amenities"), List.of("today_tomorrow", "today", "tomorrow", "yesterday", "next7", "last7", "mtd"), "today_tomorrow", ReportCatalog::bookings),
            new Def("dues", "Dues outstanding", true, true, List.of("dues"), List.of("asof"), "asof", ReportCatalog::dues),
            new Def("collections", "Payments received", false, false, List.of("dues"), List.of("yesterday", "last7", "mtd", "prevMonth", "last30"), "yesterday", ReportCatalog::collections),
            new Def("water", "Water & plant log", false, false, List.of("plantLogs"), List.of("last7", "yesterday", "mtd", "prevMonth", "last30"), "last7", ReportCatalog::water),
            new Def("tasks", "Maintenance tasks", false, false, List.of("tickets"), List.of("yesterday", "last7", "mtd", "last30"), "last7", ReportCatalog::tasks),
            new Def("audits", "Audits due", false, false, List.of("audits"), List.of("asof"), "asof", ReportCatalog::audits),
            new Def("infra", "Infrastructure health", false, false, List.of("equipment", "tickets"), List.of("asof"), "asof", ReportCatalog::infra),
            new Def("eventwork", "Event work", false, false, List.of("eventWork"), List.of("next7", "next14", "today_tomorrow"), "next7", ReportCatalog::eventwork));

    public static Def reportOf(String id) { for (Def d : REPORTS) if (d.id().equals(id)) return d; return null; }

    // ---- the custom report ----------------------------------------------------------------------------------------------

    private static String valueText(JsonNode v) { return v == null || v.isMissingNode() || v.isNull() ? "" : v.isArray() ? joinComma(v) : s(v); }
    private static String joinComma(JsonNode arr) { List<String> p = new ArrayList<>(); for (JsonNode e : arr) p.add(e.isNull() ? "" : s(e)); return String.join(", ", p); }

    private static boolean matches(JsonNode r, JsonNode flt, String today) {
        JsonNode raw = f(flt, "value");
        JsonNode value = raw.isTextual() && raw.asText().equals("@today") ? com.fasterxml.jackson.databind.node.TextNode.valueOf(today) : raw;
        JsonNode v = f(r, Js.str(flt, "field"));
        String t = (value.isMissingNode() || value.isNull() ? "" : s(value)).toLowerCase(java.util.Locale.ROOT);
        String l = valueText(v).toLowerCase(java.util.Locale.ROOT);
        String op = Js.str(flt, "op");
        return switch (op) {
            case "is" -> l.equals(t);
            case "is not" -> !l.equals(t);
            case "contains" -> l.contains(t);
            case "empty" -> l.isEmpty();
            case "not empty" -> !l.isEmpty();
            case "more than" -> Js.toNumber(v) > Js.toNumber(value);
            case "less than" -> Js.toNumber(v) < Js.toNumber(value);
            default -> true;
        };
    }

    private static List<String> texts(JsonNode arr) { List<String> out = new ArrayList<>(); if (arr != null && arr.isArray()) for (JsonNode e : arr) out.add(s(e)); return out; }

    public static Def customDef(JsonNode spec, ObjectMapper json) {
        JsonNode sp = spec;
        if (spec != null && spec.isTextual() && !spec.asText().isEmpty()) { try { sp = json.readTree(spec.asText()); } catch (Exception e) { sp = json.createObjectNode(); } }
        else if (spec == null || !spec.isObject()) sp = json.createObjectNode();
        final JsonNode spec2 = sp;
        String source = Js.truthy(spec2, "source") ? s(f(spec2, "source")) : null;
        return new Def("custom", "Custom report", false, false, source == null ? List.of() : List.of(source), periodIds(), "asof", (data, range, today, unit) -> buildCustom(spec2, data, range, today));
    }

    private static String lab(JsonNode sp, String k) { JsonNode l = f(f(sp, "labels"), k); return Js.truthy(l) ? s(l) : k; }

    private static Rep buildCustom(JsonNode sp, Map<String, List<JsonNode>> data, Range range, String today) {
        List<JsonNode> rows = new ArrayList<>(data(data, Js.truthy(sp, "source") ? s(f(sp, "source")) : ""));
        if (Js.truthy(sp, "dateField") && !range.id().equals("asof")) rows = where(rows, r -> between(f(r, s(f(sp, "dateField"))), range));
        List<JsonNode> filters = Js.list(sp, "filters");
        rows = where(rows, r -> { for (JsonNode flt : filters) if (Js.truthy(flt, "field") && !matches(r, flt, today)) return false; return true; });
        List<String> dates = texts(f(sp, "dates")), numeric = texts(f(sp, "numeric"));
        java.util.function.BiFunction<JsonNode, String, Object> cellOf = (r, k) -> {
            JsonNode v = f(r, k);
            if (v == null || v.isMissingNode() || v.isNull()) return "";
            if (v.isArray()) return joinComma(v);
            if (dates.contains(k) && Js.truthy(v)) return FinDates.dmy(v);
            return v.isBoolean() ? (v.asBoolean() ? "Yes" : "No") : cell(v);
        };
        if (Js.truthy(sp, "sortBy")) {
            String key = s(f(sp, "sortBy"));
            boolean desc = Js.is(sp, "sortDir", "desc");
            List<JsonNode> sorted = new ArrayList<>(rows);
            sorted.sort((a, b) -> {
                JsonNode x = nullish(f(a, key)), y = nullish(f(b, key));
                double n = Js.toNumber(x) - Js.toNumber(y);
                boolean emptyX = x.isTextual() && x.asText().isEmpty(), emptyY = y.isTextual() && y.asText().isEmpty();
                double o = !Double.isNaN(n) && !Double.isInfinite(n) && !emptyX && !emptyY ? n : IcuCompare.compareNumeric(s(x), s(y));
                double signed = desc ? -o : o;
                return signed < 0 ? -1 : signed > 0 ? 1 : 0;
            });
            rows = sorted;
        }
        Rep out = new Rep();
        String title = Js.truthy(sp, "title") ? s(f(sp, "title")) : "Custom report";
        out.title = title;
        if (Js.truthy(sp, "groupBy")) {
            String gk = s(f(sp, "groupBy"));
            Map<Object, List<JsonNode>> g = new LinkedHashMap<>();
            for (JsonNode r : rows) {
                Object k = cellOf.apply(r, gk);
                boolean falsy = k == null || (k instanceof String str && str.isEmpty()) || (k instanceof Double dd && (dd == 0 || dd.isNaN())) || Boolean.FALSE.equals(k);
                g.computeIfAbsent(falsy ? "—" : k, x -> new ArrayList<>()).add(r);
            }
            String m = Js.truthy(sp, "measure") && !Js.is(sp, "measure", "count") && Js.truthy(sp, "measureField") ? s(f(sp, "measure")) : "";
            String mfield = Js.truthy(sp, "measureField") ? s(f(sp, "measureField")) : "";
            List<List<Object>> grouped = new ArrayList<>();
            for (Map.Entry<Object, List<JsonNode>> e : g.entrySet()) {
                double tot = 0; int count = 0;
                if (!m.isEmpty()) for (JsonNode r : e.getValue()) { tot = tot + Js.number(r, mfield); count++; }
                List<Object> row = row(e.getKey(), (double) e.getValue().size());
                if (!m.isEmpty()) row.add(jsRound(((m.equals("avg") ? tot / (count != 0 ? count : 1) : tot)) * 100) / 100);
                grouped.add(row);
            }
            grouped.sort((a, b) -> Double.compare((Double) b.get(1), (Double) a.get(1)));
            List<String> columns = new ArrayList<>(List.of(lab(sp, gk), "Count"));
            if (!m.isEmpty()) columns.add((m.equals("avg") ? "Average" : "Total") + " " + lab(sp, mfield));
            out.lines.add(rows.size() + " record" + plural(rows.size(), "", "s") + " in " + grouped.size() + " group" + plural(grouped.size(), "", "s") + " (by " + lab(sp, gk) + ")");
            out.columns = columns; out.moneyCols = new ArrayList<>(columns.subList(1, columns.size())); out.rows = grouped; out.empty = rows.isEmpty();
            return out;
        }
        List<String> keys = new ArrayList<>();
        JsonNode cols = f(sp, "columns");
        if (cols.isArray() && cols.size() > 0) for (JsonNode c : cols) keys.add(s(c));
        else if (!rows.isEmpty() && rows.get(0).isObject()) { Iterator<String> it = rows.get(0).fieldNames(); int i = 0; while (it.hasNext() && i < 6) { keys.add(it.next()); i++; } }
        double lim = Js.number(sp, "limit");
        int limit = (int) Math.min(Integer.MAX_VALUE, lim != 0 ? lim : 500);
        List<JsonNode> shown = rows.subList(0, Math.min(Math.max(limit, 0), rows.size()));
        out.lines.add(rows.size() + " record" + plural(rows.size(), "", "s") + (rows.size() > shown.size() ? " (first " + shown.size() + " listed)" : ""));
        for (String k : keys) out.columns.add(lab(sp, k));
        for (String k : keys) if (numeric.contains(k)) out.moneyCols.add(lab(sp, k));
        for (JsonNode r : shown) { List<Object> row = new ArrayList<>(); for (String k : keys) row.add(cellOf.apply(r, k)); out.rows.add(row); }
        out.empty = rows.isEmpty();
        return out;
    }

    private static JsonNode nullish(JsonNode v) { return v == null || v.isMissingNode() || v.isNull() ? com.fasterxml.jackson.databind.node.TextNode.valueOf("") : v; }

    /** The definition a schedule uses (a built-in report, or its own custom recipe); null for an unknown report. */
    public static Def defOf(JsonNode schedule, ObjectMapper json) {
        if (Js.is(schedule, "reportType", "custom")) return customDef(f(schedule, "custom"), json);
        String id = Js.text(schedule, "reportType");
        return id == null ? null : reportOf(id);
    }

    // ---- building and shaping ----------------------------------------------------------------------------------------------

    /** Build one report (optionally for one unit). `data` can be reused across many units. */
    public static Rep buildReport(Def def, Map<String, List<JsonNode>> data, String periodId, String today, String unit, Opts opts) {
        Range range = rangeFor(def, periodId, today);
        Rep r = def.build().build(data, range, today, unit == null ? "" : unit);
        r.range = range;
        shape(r, def, opts);
        r.report = def.id();
        r.periodLabel = def.periods().size() > 1 || !range.id().equals("asof") ? range.label() : "";
        r.today = today; r.intro = opts.intro(); r.footer = opts.footer();
        return r;
    }

    private static void shape(Rep r, Def def, Opts o) {
        List<String> cols = r.columns;
        boolean[] keep = new boolean[cols.size()];
        boolean any = false;
        for (int i = 0; i < cols.size(); i++) {
            String c = cols.get(i);
            keep[i] = def.taxAware() && !o.tax() && r.taxCols.contains(c) ? false : o.columns().isEmpty() || o.columns().contains(c);
            any |= keep[i];
        }
        if (!any) java.util.Arrays.fill(keep, true);
        List<Integer> idx = new ArrayList<>();
        for (int i = 0; i < cols.size(); i++) if (keep[i]) idx.add(i);
        List<List<Object>> rows = new ArrayList<>();
        for (List<Object> row : r.rows) { List<Object> n = new ArrayList<>(); for (int i : idx) n.add(i < row.size() ? row.get(i) : null); rows.add(n); }
        List<String> columns = new ArrayList<>();
        for (int i : idx) columns.add(cols.get(i));
        List<String> lines = o.summary() ? r.lines : new ArrayList<>();
        boolean moneyShown = false;
        for (String c : r.moneyCols) if (columns.contains(c)) moneyShown = true;
        if (o.totals() && !rows.isEmpty() && moneyShown) {
            List<Object> tot = new ArrayList<>();
            for (int j = 0; j < columns.size(); j++) {
                if (j == 0) { tot.add("Total"); continue; }
                if (r.moneyCols.contains(columns.get(j))) { double sum = 0; for (List<Object> x : rows) sum += numberOf(x.get(j)); tot.add(jsRound(sum * 100) / 100); }
                else tot.add("");
            }
            rows.add(tot);
        }
        r.columns = columns; r.rows = rows; r.lines = lines;
    }

    /** `Number(x) || 0` for a cell. */
    private static double numberOf(Object x) {
        double d;
        if (x == null) return 0;
        if (x instanceof Double dd) d = dd;
        else if (x instanceof Boolean b) d = b ? 1 : 0;
        else if (x instanceof String str) d = Js.number(com.fasterxml.jackson.databind.node.TextNode.valueOf(str));
        else d = 0;
        return Double.isNaN(d) ? 0 : d;
    }

    // ---- the text of a message --------------------------------------------------------------------------------------------

    /** What a cell prints as in a bullet; null when the bullet leaves it out (empty or missing). */
    private static String bulletCell(Object x) {
        if (x == null) return null;
        if (x instanceof Double d) return FinDates.localeIn(d);
        if (x instanceof String str) return str.isEmpty() ? null : str;
        if (x instanceof Boolean b) return b ? "true" : "false";
        return Js.toStr((JsonNode) x);
    }

    /** The text of a report as sent in a message. */
    public static String textOf(Rep rep, String format, JsonNode community) {
        String comm = Js.truthy(community) ? Js.toStr(community) : "";
        String head = "*" + (!comm.isEmpty() ? comm + " · " : "") + rep.title + "*" + (!rep.periodLabel.isEmpty() ? " · " + rep.periodLabel : "") + " · " + FinDates.dmy(rep.today);
        List<String> out = new ArrayList<>();
        out.add(head);
        if (!rep.intro.isEmpty()) { out.add(""); out.add(rep.intro); }
        out.add("");
        out.addAll(rep.lines);
        if (format.equals("Detailed") && !rep.rows.isEmpty()) {
            out.add("");
            for (List<Object> r : rep.rows.subList(0, Math.min(25, rep.rows.size()))) {
                List<String> parts = new ArrayList<>();
                for (Object x : r) { String t = bulletCell(x); if (t != null) parts.add(t); }
                out.add("• " + String.join(" · ", parts));
            }
            if (rep.rows.size() > 25) out.add("…and " + (rep.rows.size() - 25) + " more (see Reports → Sent)");
        } else if ((format.equals("Excel") || format.equals("CSV")) && !rep.rows.isEmpty()) {
            out.add(""); out.add("Full table (" + rep.rows.size() + " lines) is in Reports → Sent as " + (format.equals("Excel") ? "an Excel file" : "a CSV file") + ".");
        }
        if (rep.empty) { out.add(""); out.add("Nothing to report."); }
        if (!rep.footer.isEmpty()) { out.add(""); out.add(rep.footer); }
        return String.join("\n", out);
    }

    /** JSON.stringify(rows): NaN and undefined print as null, numbers the way JavaScript writes them. */
    public static String rowsJson(List<List<Object>> rows) {
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < rows.size(); i++) {
            if (i > 0) b.append(',');
            b.append('[');
            List<Object> r = rows.get(i);
            for (int j = 0; j < r.size(); j++) {
                if (j > 0) b.append(',');
                Object x = r.get(j);
                if (x == null) b.append("null");
                else if (x instanceof Double d) b.append(Double.isNaN(d) || Double.isInfinite(d) ? "null" : Js.numberToString(d));
                else if (x instanceof Boolean bo) b.append(bo);
                else if (x instanceof String str) b.append(com.fasterxml.jackson.databind.node.TextNode.valueOf(str).toString());
                else b.append(((JsonNode) x).toString());
            }
            b.append(']');
        }
        return b.append(']').toString();
    }
}
