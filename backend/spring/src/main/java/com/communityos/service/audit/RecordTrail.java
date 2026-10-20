package com.communityos.service.audit;

import com.communityos.security.Js;
import com.communityos.security.Schema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Iterator;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The time trail the server stamps on a record (src/lib/storage/trail.js); a client can never forge it.
 *   timeline    one entry each time a status-like field changes: { field, label, from, to, at, by }
 *   dateStamps  the exact moment a date field was set or changed
 */
public final class RecordTrail {
    private RecordTrail() {}

    private static final Pattern STATUS_KEY = Pattern.compile("(status|approval)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern AT_ON = Pattern.compile("(At|On)$");
    private static final Pattern DATE_ONLY = Pattern.compile("^\\d{4}-\\d\\d-\\d\\d$");
    private static final Set<String> SKIP = Set.of("statusHistory", "timeline", "dateStamps");

    /** @return an object with "timeline" and "dateStamps", to be merged into the stamped record */
    public static ObjectNode of(ObjectMapper json, JsonNode old, JsonNode next, Schema schema, String now, String by) {
        ArrayNode timeline = json.createArrayNode();
        JsonNode oldTimeline = Js.f(old, "timeline");
        if (oldTimeline.isArray()) timeline.addAll((ArrayNode) oldTimeline.deepCopy());
        for (Iterator<String> it = next.fieldNames(); it.hasNext(); ) {
            String k = it.next();
            JsonNode v = next.get(k);
            if (SKIP.contains(k) || !STATUS_KEY.matcher(k).find() || !v.isTextual() || v.asText().isEmpty()) continue;
            JsonNode was = old == null ? Js.MISSING : Js.f(old, k);
            if (was.isTextual() && was.asText().equals(v.asText())) continue;   // `was !== next[k]`: only a different value (or none yet) is a change
            String label = schema == null ? k : schema.field(k).map(Schema.Field::label).orElse(k);
            timeline.add(json.createObjectNode().put("field", k).put("label", label).put("from", Js.str(was)).put("to", v.asText()).put("at", now).put("by", by));
        }
        ObjectNode stamps = json.createObjectNode();
        JsonNode oldStamps = Js.f(old, "dateStamps");
        if (oldStamps.isObject()) stamps.setAll((ObjectNode) oldStamps.deepCopy());
        if (schema != null) for (Schema.Field f : schema.fields()) {
            if (!"date".equals(f.type())) continue;
            JsonNode v = Js.f(next, f.key());
            if (Js.truthy(v) && (old == null || Js.differs(Js.f(old, f.key()), v))) stamps.put(f.key(), now);
        }
        // date-only values kept under plain keys (paidAt, receivedOn ...) get their time of day too
        for (Iterator<String> it = next.fieldNames(); it.hasNext(); ) {
            String k = it.next();
            if (!AT_ON.matcher(k).find() || k.equals("recordCreatedAt") || k.equals("lastUpdatedAt")) continue;
            JsonNode v = next.get(k);
            if (v.isTextual() && DATE_ONLY.matcher(v.asText()).matches() && (old == null || Js.differs(Js.f(old, k), v))) stamps.put(k, now);
        }
        return json.createObjectNode().<ObjectNode>set("timeline", timeline).set("dateStamps", stamps);
    }
}
