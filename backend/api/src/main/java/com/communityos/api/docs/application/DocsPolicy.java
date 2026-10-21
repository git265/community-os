package com.communityos.api.docs.application;

import com.communityos.api.docs.domain.Document;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/** Who reads which document and folder. The same rule runs in SQL (the list) and in memory (a single row). */
public final class DocsPolicy {
    private DocsPolicy() {}
    /** Uploads, files and changes documents and folders; reads all of them. */
    public static boolean manager(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_DOCUMENTS); }
    /** The caller's role codes as folder limits name them (the committee also as "group:EC"). */
    public static String roles(Caller c) {
        Set<String> r = new LinkedHashSet<>(c.roleCodes());
        if (c.isCommittee()) r.add("group:EC");
        return "{" + String.join(",", r.stream().map((x) -> "\"" + x.replace("\"", "") + "\"").toList()) + "}";
    }
    /** Folders: open unless a folder on the way up is limited to roles the caller does not hold. */
    public static <T> Spec<T> folders(Caller c, String folderColumn) {
        if (manager(c)) return Spec.all();
        return new Spec<>("docs.folder_open(" + folderColumn + ", CAST(:fo_roles AS text[]))", Map.of("fo_roles", roles(c)), (x) -> true);
    }
    /** Documents (alias d): by their group of readers, and inside a folder the caller may open. */
    public static Spec<Document> documents(Caller c) {
        if (manager(c)) return Spec.all();
        Map<String, Object> p = new HashMap<>();
        boolean res = c.isResident();
        p.put("dg_res", res); p.put("dg_ec", c.isCommittee()); p.put("dg_staff", c.category() == Caller.Category.Staff);
        p.put("dg_owner", c.roleCodes().contains("owner")); p.put("dg_ledger", c.has(Permission.MANAGE_LEDGER));
        p.put("dg_units", "{" + String.join(",", c.units().stream().map((u) -> u.value().toString()).toList()) + "}"); p.put("fo_roles", roles(c));
        String sql = """
            (CASE d.access
               WHEN 'Everyone' THEN TRUE
               WHEN 'All owners' THEN NOT CAST(:dg_res AS boolean) OR CAST(:dg_owner AS boolean)
               WHEN 'Executive Committee' THEN CAST(:dg_ec AS boolean)
               WHEN 'EC + Finance' THEN CAST(:dg_ec AS boolean) OR CAST(:dg_ledger AS boolean)
               WHEN 'Staff' THEN CAST(:dg_ec AS boolean) OR CAST(:dg_staff AS boolean)
               WHEN 'Villa owner / resident' THEN (CAST(:dg_res AS boolean) AND d.unit_id = ANY (CAST(:dg_units AS uuid[]))) OR (NOT CAST(:dg_res AS boolean) AND CAST(:dg_ec AS boolean))
               ELSE NOT CAST(:dg_res AS boolean) END)
            AND (d.folder_id IS NULL OR docs.folder_open(d.folder_id, CAST(:fo_roles AS text[])))""";
        return new Spec<>(sql, p, (d) -> readable(c, d));
    }
    /** The group rule in memory (the folder part is left to SQL). */
    static boolean readable(Caller c, Document d) {
        boolean res = c.isResident(), ec = c.isCommittee();
        return switch (d.access) {
            case "Everyone" -> true;
            case "All owners" -> !res || c.roleCodes().contains("owner");
            case "Executive Committee" -> ec;
            case "EC + Finance" -> ec || c.has(Permission.MANAGE_LEDGER);
            case "Staff" -> ec || c.category() == Caller.Category.Staff;
            case Document.VILLA_GROUP -> res ? d.unitId != null && c.units().stream().anyMatch((u) -> u.value().equals(d.unitId)) : ec;
            default -> !res;
        };
    }
}
