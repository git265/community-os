package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;

/** Document repository groups: who a document is for (src/lib/docGroups.js). */
public final class DocGroups {
    private DocGroups() {}

    public static final String VILLA_GROUP = "Villa owner / resident";
    private static final Map<String, String> LEGACY = Map.of("All residents", "Everyone", "Owners", "All owners", "Restricted", VILLA_GROUP);

    public static String groupOf(JsonNode r) {
        String access = Js.str(r, "access");
        if (access.isEmpty()) return "Everyone";
        return LEGACY.getOrDefault(access, access);
    }

    /** May this (non-admin) principal see this document? */
    public static boolean docVisible(JsonNode r, Principal p, RuleContext ctx) {
        String group = groupOf(r);
        String cat = p == null ? null : p.category();
        switch (group) {
            case "Everyone": return true;
            case "All owners": return !"Resident".equals(cat) || (p != null && "owner".equals(p.roleId()));
            case "Executive Committee": return "EC".equals(cat);
            case "EC + Finance": return "EC".equals(cat) || Perms.has(p, "MANAGE_LEDGER");
            case "Staff": return "EC".equals(cat) || "Staff".equals(cat);
            case VILLA_GROUP:
                return "Resident".equals(cat)
                        ? Js.truthy(r, "unit") && Js.str(r, "unit").equals(p.unit())
                        : Perms.has(p, "MANAGE_DOCUMENTS") || "EC".equals(cat);
            default: {
                RuleContext.DocGroup g = ctx.customDocGroups().stream().filter((x) -> x.name().equals(group)).findFirst().orElse(null);
                if (g == null) return !"Resident".equals(cat);
                return (p != null && g.roles().contains(p.roleId())) || ("EC".equals(cat) && g.roles().contains("group:EC"));
            }
        }
    }
}
