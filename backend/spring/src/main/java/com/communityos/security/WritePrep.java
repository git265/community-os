package com.communityos.security;

import static com.communityos.security.Perms.isAdmin;
import static com.communityos.security.Perms.isResident;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

/**
 * What a write may carry (prepareWrite / shapeForReader in src/lib/security/authz.js, round 77): the server decides what a saved record contains,
 * whatever the request says. Runs before {@link WriteRules#authorize}, for single and bulk writes, with the caller's {@link RowScope}.
 *   - update / delete: the stored record must be one the caller can see;
 *   - update: fields they are not shown keep their stored value (a write-only field they may edit is the exception), a field they may not edit
 *     cannot be removed by leaving it out, a hidden field cannot be added, and the result must stay in their scope;
 *   - create: hidden fields are dropped and the result must be in their scope (except the collections in CREATE_OUT_OF_SCOPE_OK);
 *   - identity fields (who raised / wrote / voted) are the caller's on create and frozen afterwards; a resident's villa is their own.
 */
public final class WritePrep {
    private WritePrep() {}

    /** ok + the record to save, or a refusal. */
    public record Prepared(boolean ok, String reason, JsonNode record) {
        static Prepared refuse(String reason) { return new Prepared(false, reason, null); }
        static Prepared keep(JsonNode r) { return new Prepared(true, null, r); }
    }

    private static final Map<String, Map<String, String>> IDENTITY = new LinkedHashMap<>();
    static {
        IDENTITY.put("tickets", ordered("createdBy", "name", "createdByRole", "roleId"));
        IDENTITY.put("ticketComments", ordered("author", "name", "authorRoleId", "roleId"));
        IDENTITY.put("forumPosts", ordered("author", "name", "authorRoleId", "roleId"));
        IDENTITY.put("contactReviews", ordered("author", "name"));
        IDENTITY.put("serviceContacts", ordered("addedBy", "name"));
        IDENTITY.put("culturalPhotos", ordered("uploadedBy", "name"));
        IDENTITY.put("pollVotes", ordered("voter", "name"));
        IDENTITY.put("userProfiles", ordered("userName", "name"));
        IDENTITY.put("notificationPrefs", ordered("userName", "name"));
        IDENTITY.put("wishes", ordered("raisedBy", "name", "raisedByRole", "roleId"));
        IDENTITY.put(RowScopes.IN_APP_NOTIFICATIONS, ordered("by", "name"));
    }
    private static Map<String, String> ordered(String... kv) { Map<String, String> m = new LinkedHashMap<>(); for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]); return m; }
    private static final Map<String, String> RESIDENT_UNIT = Map.of("pollVotes", "unit", "contactReviews", "unit", "serviceContacts", "addedByUnit", "wishes", "unit");
    private static final Set<String> CREATE_OUT_OF_SCOPE_OK = Set.of("files", RowScopes.IN_APP_NOTIFICATIONS, "documents", "docFolders", "ticketComments");

    private static String claim(Principal p, String from) { String v = "name".equals(from) ? p.name() : p.roleId(); return v == null ? "" : v; }

    /** Made by the server on every save: whatever a request says for these is dropped (SERVER_OWNED in authz.js). */
    private static List<String> serverOwned(String collection) {
        List<String> out = new ArrayList<>();
        for (String k : RowScopes.META_KEYS) if (!k.equals("id")) out.add(k);
        if ("tickets".equals(collection)) { out.add("ticketNumber"); out.add("statusHistory"); }
        return out;
    }
    private static ObjectNode withoutServerOwned(String collection, JsonNode next) {
        ObjectNode o = next != null && next.isObject() ? ((ObjectNode) next).deepCopy() : JsonNodeFactory.instance.objectNode();
        o.remove(serverOwned(collection));
        return o;
    }

    public static Prepared prepare(String collection, Principal p, Schema schema, JsonNode old, JsonNode next, String op, RowScope scope) {
        if (p == null) return Prepared.refuse("Not signed in");
        Predicate<JsonNode> pred = scope == null ? null : scope.predicate();
        if ("delete".equals(op)) return isAdmin(p) || old == null || pred == null || pred.test(old) ? Prepared.keep(next) : Prepared.refuse("Not found");
        if (isAdmin(p)) return Prepared.keep(withoutServerOwned(collection, next));
        if (old != null && pred != null && !pred.test(old)) return Prepared.refuse("Not found");
        ObjectNode rec = withoutServerOwned(collection, next);
        Set<String> owned = new HashSet<>(serverOwned(collection));
        Set<String> masked = new HashSet<>(FieldMasking.hiddenFieldKeys(schema, p.roleId(), p));
        Predicate<String> editable = (k) -> schema != null && schema.field(k).map((f) -> f.canEdit(p.roleId())).orElse(false);
        Predicate<String> writeOnly = (k) -> masked.contains(k) && editable.test(k);
        if (old != null) {
            JsonNode shownTo = scope != null && scope.transform() != null ? scope.transform().apply(old) : old;
            JsonNode seen = FieldMasking.mask(shownTo, schema, p.roleId(), p);
            for (Iterator<String> it = old.fieldNames(); it.hasNext(); ) {
                String k = it.next();
                if (owned.contains(k)) continue;   // the server stamps these again
                boolean shown = seen != null && seen.has(k) && !Js.differs(seen.get(k), old.get(k));
                if (!shown) { if (!(writeOnly.test(k) && rec.has(k))) rec.set(k, old.get(k)); }   // not shown to them: keeps its stored value
                else if (!rec.has(k) && !editable.test(k)) rec.set(k, old.get(k));                // cannot remove what you may not edit
            }
            List<String> drop = new ArrayList<>();
            for (Iterator<String> it = rec.fieldNames(); it.hasNext(); ) { String k = it.next(); if (!old.has(k) && masked.contains(k) && !writeOnly.test(k)) drop.add(k); }
            rec.remove(drop);
        } else {
            List<String> drop = masked.stream().filter((k) -> !writeOnly.test(k)).toList();
            rec.remove(drop);
        }
        for (Map.Entry<String, String> e : IDENTITY.getOrDefault(collection, Map.of()).entrySet()) {
            String k = e.getKey();
            if (old == null) rec.put(k, claim(p, e.getValue()));
            else if (old.has(k)) rec.set(k, old.get(k)); else rec.remove(k);
        }
        String uk = RESIDENT_UNIT.get(collection);
        if (uk != null && isResident(p)) { if (old == null) rec.put(uk, p.unit()); else if (old.has(uk)) rec.set(uk, old.get(uk)); }
        return Prepared.keep(rec);
    }

    /** After authorisation: the saved record must still be one the caller may see (create: except CREATE_OUT_OF_SCOPE_OK). Null when fine. */
    public static String staysInScope(String collection, Principal p, JsonNode old, JsonNode record, String op, RowScope scope) {
        if (p == null || isAdmin(p) || "delete".equals(op) || scope == null || scope.predicate() == null || scope.predicate().test(record)) return null;
        if (old == null && CREATE_OUT_OF_SCOPE_OK.contains(collection)) return null;
        return old != null ? "You cannot move this record out of your own view" : "You can only create records you are allowed to see";
    }

    /** What the caller gets back after a write: the record as they would read it, or only its ids when it is not theirs to read. */
    public static JsonNode shapeForReader(JsonNode record, String collection, Principal p, Schema schema, RowScope scope) {
        if (record == null || p == null || isAdmin(p)) return record;
        boolean readable = ReadRules.canRead(collection, p) && (scope == null || scope.predicate() == null || scope.predicate().test(record));
        if (!readable) {
            ObjectNode ids = JsonNodeFactory.instance.objectNode();
            if (record.has("id")) ids.set("id", record.get("id"));
            if (Js.truthy(record, "shortId")) ids.set("shortId", record.get("shortId"));
            if (record.has("recVersion") && !record.get("recVersion").isNull()) ids.set("recVersion", record.get("recVersion"));
            return ids;
        }
        JsonNode shown = scope != null && scope.transform() != null ? scope.transform().apply(record) : record;
        return FieldMasking.mask(shown, schema, p.roleId(), p);
    }
}
