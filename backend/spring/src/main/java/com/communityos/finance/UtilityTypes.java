package com.communityos.finance;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Utility types are the metered, per-unit-billed utilities (Water and DG, and any the Super Admin adds). A port of ensureUtilityTypes / syncUtilityOptions /
 * ensureUtilityNoticeTemplates in src/lib/utilityTypes.js: older communities and new empty ones get Water and DG as rows, every utility becomes a valid choice
 * wherever one is picked, and every utility gets its own "<Utility> bill" notice template.
 */
public class UtilityTypes {
    private static final List<String> BEFORE = List.of("Other", "Announcement");
    private final SystemWriter w;

    public UtilityTypes(SystemWriter w) { this.w = w; }

    /** @return true when a screen's field choices (the schema) changed, so cached community settings must be read again */
    public boolean ensure(String tenant) {
        List<JsonNode> rows = w.repo().list(tenant, "utilityTypes");
        if (rows.isEmpty()) {
            String[][] defaults = {{"Water", "💧", "Water", "kL", "UTY-0001"}, {"DG", "⚡", "DG (generator)", "kWh", "UTY-0002"}};
            for (String[] d : defaults) {
                String now = w.now();
                ObjectNode r = w.json().createObjectNode();
                r.put("id", UUID.randomUUID().toString()).put("name", d[0]).put("icon", d[1]).put("label", d[2]).put("unitName", d[3]).put("active", true)
                        .put("shortId", d[4]).put("recVersion", 1).put("recordCreatedAt", now).put("recordCreatedBy", "System").put("lastUpdatedAt", now).put("lastUpdatedBy", "System");
                w.repo().upsert(tenant, "utilityTypes", r.get("id").asText(), r);
            }
        }
        return syncOptions(tenant);
    }

    private static String billName(JsonNode name) { return Js.toStr(name) + " bill"; }

    /** Adds `value` to a select field's options (before "Other" / "Announcement" when present). @return true when something changed */
    private boolean addOption(String tenant, String sectionId, String key, JsonNode value) {
        JsonNode schema = w.repo().get(tenant, "schema", sectionId).orElse(null);
        if (schema == null) return false;
        JsonNode fields = Js.f(schema, "fields");
        if (!fields.isArray()) throw new IllegalStateException("schema " + sectionId + " has no fields");   // JavaScript: TypeError on schema.fields.find
        JsonNode field = null;
        for (JsonNode x : fields) if (Js.is(x, "key", key)) { field = x; break; }
        if (field == null || !Js.f(field, "options").isArray()) return false;
        for (JsonNode o : field.get("options")) if (Js.strictEq(o, value)) return false;
        ArrayNode opts = w.json().createArrayNode();
        for (JsonNode o : field.get("options")) if (!isBefore(o)) opts.add(o);
        opts.add(value);
        for (JsonNode o : field.get("options")) if (isBefore(o)) opts.add(o);
        ObjectNode next = ((ObjectNode) schema).deepCopy();
        ArrayNode nf = w.json().createArrayNode();
        for (JsonNode x : fields) {
            if (Js.is(x, "key", key)) { ObjectNode c = ((ObjectNode) x).deepCopy(); c.set("options", opts); nf.add(c); } else nf.add(x);
        }
        next.set("fields", nf);
        w.repo().upsert(tenant, "schema", sectionId, next);
        return true;
    }

    private static boolean isBefore(JsonNode o) { return o.isTextual() && BEFORE.contains(o.asText()); }

    /** Makes every utility a valid choice wherever one is picked (bill category, rate card, readings, "notice used for") and gives it a notice template. */
    public boolean syncOptions(String tenant) {
        boolean touched = false;
        for (JsonNode t : w.repo().list(tenant, "utilityTypes")) {
            JsonNode name = Js.f(t, "name");
            Object[][] places = {{"dues", "category", name}, {"billingTemplates", "type", name}, {"readings", "utility", name}, {"noticeTemplates", "appliesTo", TextNode.valueOf(billName(name))}};
            for (Object[] p : places) if (addOption(tenant, (String) p[0], (String) p[1], (JsonNode) p[2])) touched = true;
        }
        ensureNoticeTemplates(tenant);
        return touched;
    }

    /** Every utility gets its own "<Utility> bill" notice template (starter wording, editable in Utilities → Bill templates). */
    public void ensureNoticeTemplates(String tenant) {
        List<JsonNode> types = w.repo().list(tenant, "utilityTypes");
        List<JsonNode> tpls = w.repo().list(tenant, "noticeTemplates");
        double n = 0;
        for (JsonNode r : tpls) {
            double v = Js.toNumber(TextNode.valueOf(Js.orEmpty(Js.f(r, "shortId")).replace("NTP-", "")));
            if (Double.isNaN(v) || v == 0) v = 0;
            n = Math.max(n, v);
        }
        for (JsonNode t : types) {
            if (Js.f(t, "active").isBoolean() && !Js.f(t, "active").asBoolean()) continue;
            String applies = billName(Js.f(t, "name"));
            boolean has = false;
            for (JsonNode x : tpls) if (Js.is(x, "appliesTo", applies)) { has = true; break; }
            if (has) continue;
            String now = w.now();
            String label = Js.truthy(t, "label") ? Js.toStr(Js.f(t, "label")) : Js.toStr(Js.f(t, "name"));
            String unitName = Js.truthy(t, "unitName") ? Js.toStr(Js.f(t, "unitName")) : "units";
            n = n + 1;
            ObjectNode r = w.json().createObjectNode();
            r.put("id", UUID.randomUUID().toString()).put("shortId", "NTP-" + String.format("%04d", (long) n)).put("recVersion", 1).put("name", applies).put("appliesTo", applies);
            r.set("logo", Js.truthy(t, "icon") ? Js.f(t, "icon") : TextNode.valueOf("📊"));
            r.put("headerText", "{{SOCIETY_NAME}} · " + label + " bill");
            r.put("body", "Dear owner of {{UNIT}},\n\n" + label + " bill for {{MONTH}}\nMeter: {{PREVIOUS_READING}} → {{CURRENT_READING}} = {{UNITS_CONSUMED}} " + unitName
                    + "\nRate: ₹{{RATE}} per unit · Fixed charge ₹{{FIXED_CHARGE}} · Tax ₹{{TAX}}\nAmount payable: ₹{{AMOUNT}} by {{DUE_DATE}}.\n\nThank you,\n{{SOCIETY_NAME}} Management");
            r.put("recordCreatedAt", now).put("recordCreatedBy", "System · utilities").put("lastUpdatedAt", now).put("lastUpdatedBy", "System · utilities");
            w.repo().upsert(tenant, "noticeTemplates", r.get("id").asText(), r);
        }
    }
}
