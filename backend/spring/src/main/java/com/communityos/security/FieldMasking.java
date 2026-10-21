package com.communityos.security;

import static com.communityos.security.Perms.has;
import static com.communityos.security.Perms.isQuoteRole;
import static com.communityos.security.Perms.isResident;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Field-level reads: drop every field the role may not view (the schema's viewableBy). Meta fields and fields the schema does not know pass.
 * (maskRecord / hiddenFieldKeys in src/lib/security/authz.js)
 */
public final class FieldMasking {
    private FieldMasking() {}

    /** Collections whose access is granted by a permission (any role can be given it), not by listing role ids in the schema: holders see every field. */
    private static final Map<String, Predicate<Principal>> PERMISSION_GATED = new HashMap<>();
    static {
        PERMISSION_GATED.put("eventWork", (p) -> !isResident(p));
        PERMISSION_GATED.put("reportSchedules", Perms::canReports);
        PERMISSION_GATED.put("reportRuns", Perms::canReports);
        for (String c : ReadRules.ASSET_COLLECTIONS) PERMISSION_GATED.put(c, Perms::canAssetsRead);
        PERMISSION_GATED.put("villaImportRules", Perms::canAssetsRead);
        PERMISSION_GATED.put("readings", Perms::canManageReadings);
        PERMISSION_GATED.put("inventory", (p) -> !isResident(p));
        PERMISSION_GATED.put("inventoryRules", (p) -> !isResident(p));
        PERMISSION_GATED.put("vendorComments", (p) -> isQuoteRole(p) || has(p, "MANAGE_VENDORS"));
    }

    private static boolean gated(Schema schema, Principal p) {
        Predicate<Principal> g = p == null ? null : PERMISSION_GATED.get(schema.id());
        return g != null && g.test(p);
    }

    /** The field keys this person may NOT see in a collection (the same rule {@link #mask} applies). */
    public static List<String> hiddenFieldKeys(Schema schema, String roleId, Principal p) {
        if (schema == null || gated(schema, p)) return List.of();
        return schema.fields().stream().filter((f) -> !f.canView(roleId)).map(Schema.Field::key).toList();
    }

    public static JsonNode mask(JsonNode record, Schema schema, String roleId, Principal p) {
        if (schema == null || record == null || !record.isObject()) return record;
        List<String> hidden = hiddenFieldKeys(schema, roleId, p);
        if (hidden.isEmpty()) return record;
        ObjectNode out = ((ObjectNode) record).deepCopy();
        out.remove(hidden);
        // the record's own time trail must not repeat a hidden field (an approval's history, when a hidden date was set)
        JsonNode tl = out.get("timeline");
        if (tl != null && tl.isArray()) {
            com.fasterxml.jackson.databind.node.ArrayNode kept = out.arrayNode();
            for (JsonNode e : tl) { String f = e != null && e.isObject() ? Js.text(e, "field") : null; if (f == null || !hidden.contains(f)) kept.add(e); }
            out.set("timeline", kept);
        }
        JsonNode ds = out.get("dateStamps");
        if (ds != null && ds.isObject()) { ObjectNode d = ((ObjectNode) ds).deepCopy(); d.remove(hidden); out.set("dateStamps", d); }
        return out;
    }
}
