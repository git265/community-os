package com.communityos.service.audit;

import com.communityos.security.Js;
import com.communityos.security.RowScopes;
import com.communityos.security.Schema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** What changed in a record, as the audit trail shows it: field, label, from, to. The Java form of src/lib/audit/auditLog.js. */
public final class AuditDiff {
    private AuditDiff() {}

    private static final Pattern HTML = Pattern.compile("</?[a-z][\\s\\S]*?>", Pattern.CASE_INSENSITIVE);
    private static final int MAX_SNAPSHOT = 14;

    /** One value as a short, readable string. */
    static String shortOf(JsonNode v) {
        if (v == null || v.isMissingNode() || v.isNull() || (v.isTextual() && v.asText().isEmpty())) return "—";
        if (v.isArray()) {
            boolean plain = true;
            for (JsonNode x : v) if (x.isObject() || x.isArray() || x.isNull()) plain = false;   // typeof null === 'object' in JS
            if (!plain) return v.size() + " item(s)";
            if (v.isEmpty()) return "—";
            List<String> parts = new ArrayList<>();
            for (JsonNode x : v) parts.add(Js.str(x));
            return String.join(", ", parts);
        }
        if (v.isObject()) return "{…}";
        String s = Js.str(v);
        if (s.startsWith("data:")) return "[file]";
        if (HTML.matcher(s).find()) { s = htmlToText(s); if (s.isEmpty()) s = "—"; }
        return s.length() > 160 ? s.substring(0, 157) + "…" : s;
    }

    /** Text of a piece of HTML: tags dropped, the common entities decoded. (The web app uses the browser's parser; for an audit line this is enough.) */
    static String htmlToText(String html) {
        String t = html.replaceAll("<[^>]*>", "").replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
        return t.replace(' ', ' ').strip();
    }

    private static String labelOf(Schema schema, String key) {
        if (schema == null) return key;
        return schema.field(key).map(Schema.Field::label).orElse(key);
    }

    private static ObjectNode change(ObjectMapper json, String key, String label, String from, String to) {
        return json.createObjectNode().put("field", key).put("label", label).put("from", from).put("to", to);
    }

    /** A record at creation or deletion: its filled-in fields only (at most 14), so a deleted record can still be reviewed. */
    public static ArrayNode snapshot(ObjectMapper json, JsonNode rec, Schema schema, String kind) {
        ArrayNode out = json.createArrayNode();
        Set<String> keys = new LinkedHashSet<>();
        if (schema != null) for (Schema.Field f : schema.fields()) if (!f.hidden()) keys.add(f.key());
        if (rec != null && rec.isObject()) for (Iterator<String> it = rec.fieldNames(); it.hasNext(); ) keys.add(it.next());
        for (String key : keys) {
            if (RowScopes.META_KEYS.contains(key) || key.equals("id") || key.equals("shortId") || key.equals("recVersion")) continue;
            JsonNode v = Js.f(rec, key);
            if (v.isMissingNode() || v.isNull() || (v.isTextual() && v.asText().isEmpty()) || (v.isArray() && v.isEmpty()) || v.isObject()) continue;
            if (v.isTextual() && v.asText().startsWith("data:")) continue;
            String label = labelOf(schema, key);
            out.add("create".equals(kind) ? change(json, key, label, "—", shortOf(v)) : change(json, key, label, shortOf(v), "—"));
            if (out.size() >= MAX_SNAPSHOT) break;
        }
        return out;
    }

    /** Field-level difference between the stored record and the incoming one. */
    public static ArrayNode diff(ObjectMapper json, JsonNode old, JsonNode next, Schema schema) {
        ArrayNode out = json.createArrayNode();
        if (next == null || !next.isObject()) return out;
        for (Iterator<String> it = next.fieldNames(); it.hasNext(); ) {
            String key = it.next();
            if (RowScopes.META_KEYS.contains(key)) continue;
            JsonNode a = Js.f(old, key); JsonNode b = next.get(key);
            if (!Js.differs(b, a)) continue;
            out.add(change(json, key, labelOf(schema, key), shortOf(a), shortOf(b)));
        }
        return out;
    }
}
