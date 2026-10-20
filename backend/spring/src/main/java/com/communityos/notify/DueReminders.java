package com.communityos.notify;

import com.communityos.amenities.AmenityEngine;
import com.communityos.amenities.AmenityScheduler;
import com.communityos.finance.BillTerms;
import com.communityos.finance.FinDates;
import com.communityos.finance.LateFees;
import com.communityos.finance.SystemWriter;
import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Payment reminders for every kind of bill. The rules live in one row of the finance settings (on or off, how often, how early to start, how many nudges at
 * most); the wording is the editable "Payment reminder" notice template. A port of src/lib/dueReminders.js (reminderSettings, dueForReminder, wording,
 * runDueReminders). Safe to run as often as you like: each bill remembers when it was reminded last.
 *
 * Kept as the JavaScript has it: a cancelled bill that still shows an amount is reminded like an unpaid one (only Paid is skipped).
 */
public class DueReminders {
    public static final String SYSTEM = "System · payment reminders";
    private static final double DAY = 86400000;
    private static final Pattern SOCIETY = Pattern.compile("SOCIETY_NAME");
    static final String DEFAULT_BODY = "Dear owner of {{UNIT}},\n\nThis is a reminder that your {{UTILITY_TYPE}} bill {{BILL_NO}} of {{AMOUNT}} for {{MONTH}} is {{WHEN}} (payable by {{DUE_DATE}}).\nPlease pay it from the portal or at the office.\n\nThank you,\n{{SOCIETY_NAME}} Management";

    public record Settings(boolean enabled, double everyDays, double leadDays, double max) {}
    public record Wording(String title, String body) {}

    private final SystemWriter w;
    private final Notifier notifier;

    public DueReminders(SystemWriter w, Notifier notifier) { this.w = w; this.notifier = notifier; }

    private static JsonNode pick(JsonNode row, String key, JsonNode dflt) {
        JsonNode v = Js.f(row, key);
        return v.isMissingNode() || v.isNull() || (v.isTextual() && v.asText().isEmpty()) ? dflt : v;
    }

    public static Settings settings(JsonNode financeRow) {
        JsonNode enabled = pick(financeRow, "reminderEnabled", com.fasterxml.jackson.databind.node.BooleanNode.TRUE);
        double every = Js.number(pick(financeRow, "reminderEveryDays", com.fasterxml.jackson.databind.node.IntNode.valueOf(7)));
        double lead = Js.number(pick(financeRow, "reminderLeadDays", com.fasterxml.jackson.databind.node.IntNode.valueOf(3)));
        double max = Js.number(pick(financeRow, "reminderMax", com.fasterxml.jackson.databind.node.IntNode.valueOf(4)));
        return new Settings(!(enabled.isBoolean() && !enabled.asBoolean()), Math.max(1, every != 0 ? every : 7), Math.max(0, lead), Math.max(1, max != 0 ? max : 4));
    }

    /** Which unpaid bills are due a reminder right now. force = ignore the on/off switch, the frequency and the lead time (a manual "send now"). */
    public static List<JsonNode> dueForReminder(List<JsonNode> dues, Settings s, long nowMillis, boolean force, ZoneId zone) {
        String todayIso = FinDates.fmt(Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate());
        double today = AmenityEngine.parseLocal(todayIso + "T00:00:00", zone);
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode d : dues) {
            if (Js.is(d, "status", "Paid") || !(Js.number(d, "amount") > 0) || !Js.truthy(d, "unit")) continue;
            if (!force) {
                if (Js.number(d, "reminderCount") >= s.max()) continue;
                double due = Js.truthy(d, "dueDate") ? AmenityEngine.parseLocal(Js.toStr(Js.f(d, "dueDate")) + "T00:00:00", zone) : Double.NaN;
                if (!Double.isNaN(due) && today < due - s.leadDays() * DAY) continue;
                double last = Js.truthy(d, "reminderSentAt") ? AmenityScheduler.millis(Js.f(d, "reminderSentAt")) : Double.NaN;
                if (!Double.isNaN(last) && nowMillis - last < s.everyDays() * DAY - 60000) continue;
            }
            out.add(d);
        }
        return out;
    }

    /** `String.split(key).join(value)`: JavaScript joins with "," when the value is undefined, and with "null" when it is null. */
    private static String fill(String t, Map<String, JsonNode> map) {
        String x = t == null ? "" : t;
        for (Map.Entry<String, JsonNode> e : map.entrySet()) {
            JsonNode v = e.getValue();
            String sep = v == null || v.isMissingNode() ? "," : Js.toStr(v);
            x = String.join(sep, split(x, e.getKey()));
        }
        return x;
    }

    private static List<String> split(String x, String key) {
        List<String> out = new ArrayList<>();
        int from = 0;
        while (true) { int i = x.indexOf(key, from); if (i < 0) break; out.add(x.substring(from, i)); from = i + key.length(); }
        out.add(x.substring(from));
        return out;
    }

    public static Wording wording(JsonNode due, JsonNode society, long nowMillis, JsonNode tpl, ZoneId zone) {
        String today = FinDates.fmt(Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate());
        JsonNode dueDate = Js.f(due, "dueDate");
        boolean late = Js.truthy(dueDate) && lessThan(dueDate, today);
        double days = late ? Math.rint(AmenityEngine.jsRound((AmenityEngine.parseLocal(today + "T00:00:00", zone) - AmenityEngine.parseLocal(Js.toStr(dueDate) + "T00:00:00", zone)) / DAY)) : 0;
        Map<String, JsonNode> map = new LinkedHashMap<>();
        map.put("{{UNIT}}", Js.f(due, "unit"));
        map.put("{{AMOUNT}}", TextNode.valueOf(FinDates.inr(Js.f(due, "amount"))));
        map.put("{{MONTH}}", Js.truthy(due, "billedMonth") ? Js.f(due, "billedMonth") : TextNode.valueOf(""));
        map.put("{{DUE_DATE}}", TextNode.valueOf(FinDates.dmy(dueDate)));
        map.put("{{UTILITY_TYPE}}", Js.is(due, "category", "Maintenance") ? TextNode.valueOf("maintenance") : Js.f(due, "category"));
        map.put("{{BILL_NO}}", Js.truthy(due, "shortId") ? Js.f(due, "shortId") : TextNode.valueOf(""));
        map.put("{{WHEN}}", TextNode.valueOf(late ? "overdue by " + Js.numberToString(days) + " day" + (days == 1 ? "" : "s") : "coming up"));
        map.put("{{SOCIETY_NAME}}", society);
        map.put("{{DAYS_OVERDUE}}", TextNode.valueOf(Js.numberToString(days)));
        JsonNode header = Js.f(tpl, "headerText");
        String titleTemplate = Js.truthy(header) && !SOCIETY.matcher(Js.toStr(header)).find() ? Js.toStr(header) : "{{UTILITY_TYPE}} payment reminder · {{BILL_NO}}";
        JsonNode body = Js.f(tpl, "body");
        return new Wording(fill(titleTemplate, map), fill(Js.truthy(body) ? Js.toStr(body) : DEFAULT_BODY, map));
    }

    /** `due.dueDate < today` for a text date (a text compares with a text by characters; any other value is turned into a number first). */
    private static boolean lessThan(JsonNode dueDate, String today) {
        if (dueDate.isTextual()) return dueDate.asText().compareTo(today) < 0;
        return false;
    }

    /** @return how many reminders were sent */
    public int run(String tenant, ZoneId zone, boolean force) {
        List<JsonNode> fin = w.repo().list(tenant, "financeSettings");
        JsonNode financeRow = fin.isEmpty() ? w.json().createObjectNode() : fin.get(0);
        Settings s = settings(financeRow);
        if (!force && !s.enabled()) return 0;
        long now = w.clock().millis();
        List<JsonNode> list = dueForReminder(w.repo().list(tenant, "dues"), s, now, force, zone);
        if (list.isEmpty()) return 0;
        JsonNode society = null;
        for (JsonNode m : w.repo().list(tenant, "mergeFields")) if (Js.is(m, "token", "{{SOCIETY_NAME}}")) { society = Js.f(m, "defaultValue"); break; }
        JsonNode soc = society != null && Js.truthy(society) ? society : TextNode.valueOf("Community");
        JsonNode tpl = null;
        for (JsonNode t : w.repo().list(tenant, "noticeTemplates")) if (Js.is(t, "appliesTo", "Payment reminder")) { tpl = t; break; }
        LateFees.Settings fees = null;
        try { fees = LateFees.settings(financeRow, w.json()); } catch (RuntimeException e) { fees = null; }   // unreadable rules: the message just leaves the late-fee sentence out
        String today = FinDates.today(w.clock(), zone);
        List<Notifier.Item> items = new ArrayList<>();
        for (JsonNode d : list) {
            Wording wd = wording(d, soc, now, tpl, zone);
            items.add(new Notifier.Item("payment_reminder", wd.title(), wd.body() + BillTerms.termsFor(d, fees, today)).link("").kind("payment_reminder").by(SYSTEM).toUnit(Js.f(d, "unit")));
        }
        notifier.notifyMany(tenant, items);
        String stamp = w.now();
        List<ObjectNode> updated = new ArrayList<>();
        for (JsonNode d : list) {
            ObjectNode n = ((ObjectNode) d).deepCopy();
            n.put("reminderSentAt", stamp);
            JsonNode c = Js.f(d, "reminderCount");
            if (!Js.truthy(c)) n.put("reminderCount", 1);
            else if (c.isNumber()) n.set("reminderCount", AmenityEngine.num(c.asDouble() + 1));
            else n.put("reminderCount", Js.toStr(c) + "1");
            updated.add(n);
        }
        w.putMany(tenant, "dues", updated);
        w.event(tenant, SYSTEM, "Billing & Finance", "Update", "", "Payment reminder sent for " + list.size() + " unpaid bill" + (list.size() == 1 ? "" : "s") + (force ? " (sent manually)" : ""));
        return list.size();
    }

    public int run(String tenant, ZoneId zone) { return run(tenant, zone, false); }
}
