package com.communityos.finance;

import static com.communityos.amenities.AmenityEngine.num;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

/**
 * Raise this month's association bill for every active recurring bill that has not had one yet. A port of runRecurringBills in src/lib/finance/rules.js.
 * Safe to run any number of times: a recurring bill remembers the month it last raised (lastMonth).
 */
public class RecurringBills {
    public static final String SYSTEM = "System · recurring bills";
    private final SystemWriter w;

    public RecurringBills(SystemWriter w) { this.w = w; }

    /** @return how many bills were raised */
    public int run(String tenant, ZoneId zone) { return run(tenant, zone, SYSTEM); }

    public int run(String tenant, ZoneId zone, String actor) {
        String key = FinDates.monthKey(w.clock(), zone);
        List<JsonNode> recs = new ArrayList<>();
        for (JsonNode r : w.repo().list(tenant, "recurringBills"))
            if (!(Js.f(r, "active").isBoolean() && !Js.f(r, "active").asBoolean()) && !Js.strictEq(Js.f(r, "lastMonth"), TextNode.valueOf(key)) && Js.number(r, "amount") > 0) recs.add(r);
        if (recs.isEmpty()) return 0;
        List<ObjectNode> bills = new ArrayList<>();
        for (JsonNode r : recs) {
            double asked = Js.number(r, "dayOfMonth");
            double day = Math.min(28, Math.max(1, asked != 0 ? asked : 10));
            String dayText = Js.numberToString(day);
            if (dayText.length() < 2) dayText = "0" + dayText;
            ObjectNode b = w.json().createObjectNode();
            b.set("utility", Js.truthy(r, "utility") ? Js.f(r, "utility") : TextNode.valueOf("Other"));
            b.set("location", Js.truthy(r, "location") ? Js.f(r, "location") : TextNode.valueOf("Common area"));
            Js.set(b, "provider", Js.f(r, "provider"));
            b.put("period", key).put("billDate", key + "-01").put("dueDate", key + "-" + dayText);
            b.set("amount", num(Js.number(r, "amount")));
            b.put("notes", "Raised automatically from the recurring bill \"" + Js.toStr(Js.f(r, "description")) + "\"");
            Js.set(b, "recurringId", Js.f(r, "id"));
            bills.add(w.stamp(b, actor, w.nextShortId(tenant, "assocBills")));
        }
        w.putMany(tenant, "assocBills", bills);
        String now = w.now();
        List<ObjectNode> updated = new ArrayList<>();
        for (JsonNode r : recs) { ObjectNode n = ((ObjectNode) r).deepCopy(); n.put("lastMonth", key).put("lastUpdatedAt", now).put("lastUpdatedBy", actor); updated.add(n); }
        w.putMany(tenant, "recurringBills", updated);
        w.event(tenant, actor, "Billing & Finance", "Create", "", bills.size() + " recurring bill(s) raised for " + key);
        return bills.size();
    }
}
