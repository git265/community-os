package com.communityos.reports;

import com.communityos.finance.FinDates;
import com.communityos.finance.SystemWriter;
import com.communityos.notify.Notifier;
import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.time.DayOfWeek;
import java.time.LocalDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Produces and delivers scheduled reports. A port of dueKey / runSchedule / runReportSchedules / audienceText in src/lib/reports/run.js: a schedule runs once per day,
 * week or month after its time of day, on the channels it names (personal opt-in is not consulted), and remembers the day it last ran (lastRunKey).
 */
public class ReportSchedules {
    private static final Logger log = LoggerFactory.getLogger(ReportSchedules.class);
    public static final String SYSTEM = "System · scheduled reports";
    private static final String[] WEEKDAYS = {"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"};
    private static final Pattern SPLIT = Pattern.compile("[,;\\s]+");
    private static final Pattern PHONE = Pattern.compile("^\\+?\\d");

    public record Run(ReportCatalog.Rep rep, boolean silent, int inApp, int queued, int skipped, String sentTo) {}

    private final SystemWriter w;
    private final Notifier notifier;

    public ReportSchedules(SystemWriter w, Notifier notifier) { this.w = w; this.notifier = notifier; }

    private LocalDateTime local(ZoneId zone) { return LocalDateTime.ofInstant(w.clock().instant(), zone); }

    /** The key of the run that is due now, or "" when nothing is due. */
    public static String dueKey(JsonNode s, LocalDateTime now) {
        if (!Js.truthy(s, "active") || !Js.truthy(s, "reportType")) return "";
        String today = FinDates.fmt(now.toLocalDate());
        String hhmm = String.format("%02d:%02d", now.getHour(), now.getMinute());
        JsonNode time = Js.truthy(s, "time") ? Js.f(s, "time") : TextNode.valueOf("08:00");
        if (time.isTextual() && hhmm.compareTo(time.asText()) < 0) return "";   // a time that is not text never compares (NaN): the schedule is not held back
        if (Js.is(s, "frequency", "Weekly")) {
            String day = WEEKDAYS[now.getDayOfWeek() == DayOfWeek.SUNDAY ? 0 : now.getDayOfWeek().getValue()];
            JsonNode want = Js.truthy(s, "weekday") ? Js.f(s, "weekday") : TextNode.valueOf("Monday");
            if (!Js.strictEq(TextNode.valueOf(day), want)) return "";
        } else if (Js.is(s, "frequency", "Monthly")) {
            int last = YearMonth.from(now).lengthOfMonth();
            double md = Js.number(s, "monthDay");
            if (now.getDayOfMonth() != Math.min(md != 0 ? md : 1, last)) return "";
        }
        return Js.strictEq(Js.f(s, "lastRunKey"), TextNode.valueOf(today)) ? "" : today;
    }

    static List<String> splitExtra(JsonNode t) {
        List<String> out = new ArrayList<>();
        for (String x : SPLIT.split(Js.orEmpty(t), -1)) { String y = Js.trim(x); if (!y.isEmpty()) out.add(y); }
        return out;
    }

    private static double len(JsonNode n) { if (!Js.truthy(n)) return 0; if (n.isArray()) return n.size(); if (n.isTextual()) return n.asText().length(); return Double.NaN; }

    public static String audienceText(JsonNode s) {
        String base = "";
        String aud = Js.text(s, "audience");
        if (aud != null) switch (aud) {
            case "Roles" -> { double n = len(Js.f(s, "roleIds")); base = Js.numberToString(n) + " role" + (n == 1 ? "" : "s"); }
            case "People" -> { double n = len(Js.f(s, "people")); base = Js.numberToString(n) + " " + (n == 1 ? "person" : "people"); }
            case "All villas" -> base = "All villas";
            case "Selected villas" -> { double n = len(Js.f(s, "units")); base = Js.numberToString(n) + " villa" + (n == 1 ? "" : "s"); }
            default -> base = "";
        }
        int extra = splitExtra(Js.f(s, "extra")).size();
        return base + (extra > 0 ? " + " + extra + " other" : "");
    }

    private Map<String, List<JsonNode>> loadData(String tenant, List<String> needs) {
        Map<String, List<JsonNode>> out = new HashMap<>();
        for (String c : needs) out.put(c, w.repo().list(tenant, c));
        return out;
    }

    /** Run one schedule now. @param manual true for "Send now" (no lastRunKey, "run by hand" in the log) */
    public Run runSchedule(String tenant, JsonNode s, ZoneId zone, String by, boolean manual) {
        ReportCatalog.Def def = ReportCatalog.defOf(s, w.json());
        if (def == null) throw new IllegalArgumentException("Unknown report");
        LocalDateTime now = local(zone);
        String today = FinDates.fmt(now.toLocalDate());
        Map<String, List<JsonNode>> data = loadData(tenant, def.needs());
        String period = Js.text(s, "period");
        ReportCatalog.Opts opts = ReportCatalog.optsOf(s);
        ReportCatalog.Rep rep = ReportCatalog.buildReport(def, data, period, today, "", opts);
        JsonNode society = null;
        for (JsonNode m : w.repo().list(tenant, "mergeFields")) if (Js.is(m, "token", "{{SOCIETY_NAME}}")) { society = Js.f(m, "defaultValue"); break; }
        JsonNode soc = society != null && Js.truthy(society) ? society : TextNode.valueOf("");
        List<String> channels = new ArrayList<>();
        JsonNode ch = Js.f(s, "channels");
        if (Js.truthy(ch) && len(ch) > 0 && ch.isArray()) for (JsonNode c : ch) channels.add(Js.toStr(c)); else channels.add("In-app");
        String fmt = Js.truthy(s, "format") ? Js.toStr(Js.f(s, "format")) : "Summary";
        List<Notifier.ExtraTo> extraTo = new ArrayList<>();
        for (String x : splitExtra(Js.f(s, "extra"))) extraTo.add(new Notifier.ExtraTo(x.contains("@") ? "Email" : PHONE.matcher(x).find() ? "SMS" : "Email", x));
        String wholeText = ReportCatalog.textOf(rep, fmt, soc);
        List<Notifier.Item> items = new ArrayList<>();
        String sentTo;
        String aud = Js.text(s, "audience");
        if ("All villas".equals(aud) || "Selected villas".equals(aud)) {
            List<JsonNode> units = new ArrayList<>();
            if ("All villas".equals(aud)) for (String u : notifier.unitsWithPeople(tenant)) units.add(TextNode.valueOf(u));
            else Js.list(s, "units").forEach(units::add);
            for (JsonNode u : units) {
                ReportCatalog.Rep r = def.perUnit() ? ReportCatalog.buildReport(def, data, period, today, Js.toStr(u), opts) : rep;
                if (def.perUnit() && r.empty) continue;
                items.add(new Notifier.Item("report", r.title, ReportCatalog.textOf(r, fmt, soc)).toUnit(u).by(by));
            }
            sentTo = items.size() + " villa" + (items.size() == 1 ? "" : "s") + (def.perUnit() ? " (each sees only its own)" : "");
            if (!extraTo.isEmpty()) { Notifier.Item it = new Notifier.Item("report", rep.title, wholeText); it.extraTo = extraTo; items.add(it); sentTo += " + " + extraTo.size() + " other"; }
        } else {
            if ("People".equals(aud)) for (JsonNode n : Js.list(s, "people")) items.add(new Notifier.Item("report", rep.title, wholeText).by(by).toName(n));
            else {
                JsonNode roles = Js.truthy(s, "roleIds") ? Js.f(s, "roleIds") : w.json().createArrayNode();
                items.add(new Notifier.Item("report", rep.title, wholeText).by(by).toRoleIds(roles));
            }
            if (!extraTo.isEmpty()) { Notifier.Item it = new Notifier.Item("report", rep.title, wholeText); it.extraTo = extraTo; items.add(it); }
            sentTo = audienceText(s);
        }
        boolean silent = !manual && Js.truthy(s, "skipEmpty") && rep.empty;
        Notifier.Delivered res = new Notifier.Delivered(0, 0, 0);
        if (!silent) res = notifier.deliverDirect(tenant, items, channels, "report");
        String runAt = w.now();
        if (!silent) {
            ObjectNode run = w.json().createObjectNode();
            run.put("id", UUID.randomUUID().toString());
            run.set("scheduleId", Js.truthy(s, "id") ? Js.f(s, "id") : TextNode.valueOf(""));
            run.set("name", Js.truthy(s, "name") ? Js.f(s, "name") : TextNode.valueOf(rep.title));
            run.put("runAt", runAt).put("title", rep.title).put("summary", String.join("\n", rep.lines));
            ArrayNode cols = w.json().createArrayNode(); rep.columns.forEach(cols::add); run.set("columns", cols);
            run.put("rows", ReportCatalog.rowsJson(rep.rows));
            run.put("sentTo", sentTo + " · " + String.join(", ", channels) + (manual ? " · run by hand" : ""));
            run.put("recordCreatedAt", runAt).put("recordCreatedBy", by).put("lastUpdatedAt", runAt).put("lastUpdatedBy", by);
            w.repo().upsert(tenant, "reportRuns", run.get("id").asText(), run);
        }
        if (Js.truthy(s, "id") && !manual) {
            ObjectNode n = ((ObjectNode) s).deepCopy();
            n.put("lastRunKey", today);
            w.repo().upsert(tenant, "reportSchedules", Js.toStr(Js.f(s, "id")), n);
        }
        w.event(tenant, by, "Reports", "Create", "", silent ? Js.toStr(Js.f(s, "name")) + ": nothing to report, not sent"
                : Js.toStr(Js.f(s, "name")) + ": sent to " + sentTo + " (" + String.join(", ", channels) + ")");
        return new Run(rep, silent, res.inApp(), res.queued(), res.skipped(), sentTo);
    }

    /** The background job: runs every schedule that is due now. A schedule that fails is logged and the others still run. @return how many ran */
    public int runDue(String tenant, ZoneId zone) {
        LocalDateTime now = local(zone);
        int n = 0;
        for (JsonNode s : w.repo().list(tenant, "reportSchedules")) {
            if (dueKey(s, now).isEmpty()) continue;
            try { runSchedule(tenant, s, zone, SYSTEM, false); n++; }
            catch (RuntimeException e) { log.warn("report failed {}: {}", Js.str(Js.f(s, "name")), e.toString()); }
        }
        return n;
    }
}
