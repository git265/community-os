package com.communityos.finance;

import static com.communityos.amenities.AmenityEngine.num;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Late fees: the rule of each kind of bill, which fees are due now, and adding them. A port of lateFeeSettings / ruleFor / planLateFees / applyLateFees /
 * runAutoLateFees in src/lib/finance/rules.js. One fee per overdue bill per month, fees never earn fees, every bill follows the rule of its own category.
 * Held equal to the JavaScript by FinanceConformanceCheck.
 */
public class LateFees {
    public static final String SYSTEM = "System · late fees";

    /** One late-fee rule; `appliesTo` is a bill category or "*" (every other bill). */
    public record Rule(JsonNode id, JsonNode appliesTo, String kind, double value, double grace, double maxMonths) {}
    public record Settings(boolean enabled, boolean auto, List<Rule> rules, String kind, double value, double grace, double maxMonths) {}
    public record Planned(JsonNode due, int no, double amount, Rule rule) {}
    public record Applied(int created, double total, List<ObjectNode> rows) {}

    private final SystemWriter w;

    public LateFees(SystemWriter w) { this.w = w; }

    // ---- the rules -----------------------------------------------------------------------------------------------------

    private static Rule cleanRule(JsonNode r, int i) {
        if (r == null || r.isNull()) throw new IllegalStateException("A late-fee rule is empty");   // JavaScript: TypeError reading r.id
        JsonNode id = Js.truthy(r, "id") ? Js.f(r, "id") : TextNode.valueOf("r" + i);
        JsonNode applies = Js.truthy(r, "appliesTo") ? Js.f(r, "appliesTo") : TextNode.valueOf("*");
        return new Rule(id, applies, Js.is(r, "kind", "Fixed per month") ? "Fixed per month" : "Percent per month", Js.number(r, "value"), Math.max(0, Js.number(r, "grace")), Js.number(r, "maxMonths"));
    }

    /** @param financeSettings the (single) row of the financeSettings collection, or an empty object */
    public static Settings settings(JsonNode financeSettings, ObjectMapper json) {
        List<Rule> rules = new ArrayList<>();
        JsonNode raw = Js.f(financeSettings, "lateFeeRules");
        try {
            JsonNode parsed = parseRules(raw, json);
            if (parsed != null && parsed.isArray()) { int i = 0; for (JsonNode r : parsed) rules.add(cleanRule(r, i++)); }
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) { rules = new ArrayList<>(); }
        // communities set up before per-bill rules keep their single rule as the "all other bills" rule
        if (rules.isEmpty() && Js.number(financeSettings, "lateFeeValue") > 0) {
            ObjectNode d = json.createObjectNode();
            d.put("id", "default"); d.put("appliesTo", "*");
            Js.set(d, "kind", Js.f(financeSettings, "lateFeeKind")); Js.set(d, "value", Js.f(financeSettings, "lateFeeValue"));
            Js.set(d, "grace", Js.f(financeSettings, "lateFeeGraceDays")); Js.set(d, "maxMonths", Js.f(financeSettings, "lateFeeMaxMonths"));
            rules.add(cleanRule(d, 0));
        }
        Rule first = null;
        for (Rule r : rules) if (Js.strictEq(r.appliesTo(), TextNode.valueOf("*"))) { first = r; break; }
        if (first == null) first = rules.isEmpty() ? cleanRule(json.createObjectNode(), 0) : rules.get(0);
        return new Settings(Js.truthy(financeSettings, "lateFeeEnabled"), Js.truthy(financeSettings, "lateFeeAuto"), List.copyOf(rules), first.kind(), first.value(), first.grace(), first.maxMonths());
    }

    /** `JSON.parse(r.lateFeeRules || '[]')`: a text is read as JSON; anything else is turned into text first, which JSON.parse almost never accepts. */
    private static JsonNode parseRules(JsonNode raw, ObjectMapper json) throws com.fasterxml.jackson.core.JsonProcessingException {
        if (!Js.truthy(raw)) return json.createArrayNode();
        String text = Js.toStr(raw);
        return json.readTree(text);
    }

    /** The rule that governs a bill: the one set for its category, else the "all other bills" rule; null when there is none or it charges nothing. */
    public static Rule ruleFor(Settings s, JsonNode category) {
        if (s == null) return null;
        Rule hit = null;
        for (Rule r : s.rules()) if (Js.strictEq(r.appliesTo(), category)) { hit = r; break; }
        if (hit == null) for (Rule r : s.rules()) if (!Js.truthy(r.appliesTo()) || Js.strictEq(r.appliesTo(), TextNode.valueOf("*"))) { hit = r; break; }
        return hit != null && hit.value() > 0 ? hit : null;
    }

    private static double feeFor(Rule rule, JsonNode d) {
        double base = Js.number(d, "grossAmount") != 0 ? Js.number(d, "grossAmount") : Js.number(d, "amount");
        return rule.kind().equals("Fixed per month") ? FinDates.r2(rule.value()) : FinDates.r2((base * rule.value()) / 100);
    }

    /** Late fees that are due now and not yet charged. */
    public static List<Planned> plan(List<JsonNode> dues, Settings s, String asOf) {
        Set<String> have = new HashSet<>();
        for (JsonNode d : dues) if (Js.truthy(d, "lateFeeFor")) have.add(Js.toStr(Js.f(d, "lateFeeFor")) + "#" + Js.toStr(Js.f(d, "lateFeeNo")));
        List<Planned> out = new ArrayList<>();
        for (JsonNode d : dues) {
            if (Js.is(d, "status", "Paid") || Js.is(d, "category", "Late fee") || !Js.truthy(d, "dueDate") || !(Js.number(d, "amount") > 0) || !Js.truthy(d, "unit")) continue;
            Rule rule = ruleFor(s, Js.f(d, "category"));
            if (rule == null) continue;
            String start = FinDates.addDays(Js.toStr(Js.f(d, "dueDate")), rule.grace());
            double cap = rule.maxMonths() > 0 ? rule.maxMonths() : 36;
            for (int k = 1; k <= cap; k++) {
                if (asOf.compareTo(FinDates.addMonths(start, k - 1)) <= 0) break;
                if (have.contains(Js.toStr(Js.f(d, "id")) + "#" + k)) continue;
                double amount = feeFor(rule, d);
                if (amount > 0) out.add(new Planned(d, k, amount, rule));
            }
        }
        return out;
    }

    // ---- adding them ---------------------------------------------------------------------------------------------------

    /**
     * @param only add the fees of this one bill only (null = every bill)
     * @param auto true for the background job (only changes the audit wording)
     */
    public Applied apply(String tenant, String asOf, String actor, boolean auto, String only) {
        List<JsonNode> financeRows = w.repo().list(tenant, "financeSettings");
        Settings s = settings(financeRows.isEmpty() ? w.json().createObjectNode() : financeRows.get(0), w.json());
        List<JsonNode> dues = w.repo().list(tenant, "dues");
        List<Planned> plan = new ArrayList<>();
        for (Planned p : plan(dues, s, asOf)) if (only == null || Js.is(p.due(), "id", only)) plan.add(p);
        if (plan.isEmpty()) return new Applied(0, 0, List.of());
        List<ObjectNode> rows = new ArrayList<>();
        for (Planned p : plan) {
            JsonNode due = p.due();
            ObjectNode r = w.json().createObjectNode();
            Js.set(r, "unit", Js.f(due, "unit"));
            r.put("category", "Late fee");
            r.set("amount", num(p.amount()));
            r.put("billedMonth", "Late fee · " + (Js.truthy(due, "billedMonth") ? Js.toStr(Js.f(due, "billedMonth")) : Js.toStr(Js.f(due, "shortId"))) + " · month " + p.no());
            r.put("dueDate", asOf).put("status", "Unpaid");
            Js.set(r, "lateFeeFor", Js.f(due, "id"));
            r.put("lateFeeNo", p.no());
            r.set("billTo", Js.truthy(due, "billTo") ? Js.f(due, "billTo") : TextNode.valueOf("Owner"));
            r.set("billedTo", Js.truthy(due, "billedTo") ? Js.f(due, "billedTo") : TextNode.valueOf(""));
            r.put("notice", "Late fee for " + Js.toStr(Js.f(due, "category")) + " bill " + Js.orEmpty(Js.f(due, "shortId")) + " (" + Js.orEmpty(Js.f(due, "billedMonth"))
                    + "), unpaid after " + FinDates.dmy(Js.f(due, "dueDate")) + ".");
            rows.add(w.stamp(r, actor, w.nextShortId(tenant, "dues")));
        }
        w.putMany(tenant, "dues", rows);
        double sum = 0;
        for (ObjectNode r : rows) sum += r.get("amount").asDouble();
        double total = FinDates.r2(sum);
        Set<JsonNode> units = new LinkedHashSet<>();
        for (ObjectNode r : rows) units.add(r.get("unit"));
        w.event(tenant, actor, "Billing & Finance", "Create", "",
                "Late fees " + (auto ? "added automatically" : "applied") + ": " + rows.size() + " fee" + (rows.size() == 1 ? "" : "s") + ", " + FinDates.inr(total) + " on " + units.size() + " unit(s)");
        return new Applied(rows.size(), total, rows);
    }

    /** The background job: late fees are added on their own, when the community switched that on. */
    public int runAuto(String tenant, ZoneId zone) {
        List<JsonNode> financeRows = w.repo().list(tenant, "financeSettings");
        Settings s = settings(financeRows.isEmpty() ? w.json().createObjectNode() : financeRows.get(0), w.json());
        if (!s.enabled() || !s.auto()) return 0;
        return apply(tenant, FinDates.today(w.clock(), zone), SYSTEM, true, null).created();
    }
}
