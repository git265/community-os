package com.communityos.security;

import static com.communityos.security.Perms.has;
import static com.communityos.security.Perms.isAdmin;
import static com.communityos.security.Perms.isEC;
import static com.communityos.security.Perms.isQuoteRole;
import static com.communityos.security.Perms.isResident;

import com.communityos.domain.ScopeNode;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

/**
 * Row-level scope (rowScope in src/lib/security/authz.js): residents get their own unit's rows, a staff member without the audit permission
 * only unit activity, an announcement only reaches the people it is addressed to, and so on. Where the rule is exactly expressible as data it
 * carries an SQL form, so the database filters instead of the server loading the collection.
 */
public final class RowScopes {
    private RowScopes() {}

    public static final List<String> META_KEYS = List.of("id", "shortId", "recVersion", "recordCreatedAt", "recordCreatedBy", "lastUpdatedAt", "lastUpdatedBy", "updatedAt", "timeline", "dateStamps");
    private static final List<String> DIRECTORY_FIELDS = List.of("id", "unit", "type", "zone", "owner", "ownerPhone", "occupancy");
    private static final Set<String> NONE = Set.of();

    public static RowScope rowScope(String collection, Principal p, RawReader raw, RuleContext ctx) {
        RowScope base = BlockScope.narrow(collection, p, raw, baseRowScope(collection, p, raw, ctx));
        if (isAdmin(p) || (!collection.equals("documents") && !collection.equals("docFolders"))) return base;
        List<JsonNode> folders = raw.read("docFolders");
        Predicate<JsonNode> bp = base.predicate();
        // a folder rule is walked in memory: it has no database form (so `sql` is dropped)
        if (collection.equals("docFolders")) return new RowScope((r) -> folderAllowed(Js.text(r, "id"), folders, p) && (bp == null || bp.test(r)), null, base.transform());
        return new RowScope((r) -> (!Js.truthy(r, "folderId") || folderAllowed(Js.text(r, "folderId"), folders, p)) && (bp == null || bp.test(r)), null, base.transform());
    }

    /** A folder can be limited to chosen roles (accessRoles); the limit applies to everything inside it, sub-folders included. Empty = no extra limit. */
    public static boolean folderAllowed(String folderId, List<JsonNode> folders, Principal p) {
        JsonNode cur = find(folders, folderId); int n = 0;
        while (cur != null && n++ < 30) {
            List<String> roles = Js.strings(cur, "accessRoles");
            if (!roles.isEmpty() && !roles.contains(p.roleId()) && !(roles.contains("group:EC") && "EC".equals(p.category()))) return false;
            cur = find(folders, Js.text(cur, "parentId"));
        }
        return true;
    }
    private static JsonNode find(List<JsonNode> folders, String id) {
        if (id == null) return null;
        for (JsonNode f : folders) if (id.equals(Js.text(f, "id"))) return f;
        return null;
    }

    /** Does an announcement address this (resident) principal? */
    public static boolean broadcastReaches(JsonNode b, Principal p) {
        boolean owner = "owner".equals(p.roleId());
        List<String> units = Js.strings(b, "audienceUnits");
        String audience = Js.text(b, "audience");
        if (audience == null) return false;
        switch (audience) {
            case "All residents": return true;
            case "Owners": return owner;
            case "All villas": return !units.isEmpty() ? units.contains(p.unit()) : p.unit().toLowerCase().contains("villa");
            case "All apartments": case "Apartment blocks": return !units.isEmpty() ? units.contains(p.unit()) : !p.unit().isEmpty() && !p.unit().toLowerCase().contains("villa");
            case "Selected villas": case "Selected apartments": case "Selected blocks": return units.contains(p.unit());
            default: return false;   // EC members, Staff
        }
    }

    private static ScopeNode ownUnit(String unit) { return unit.isEmpty() ? new ScopeNode.None() : new ScopeNode.Eq("unit", unit); }
    private static boolean unitIs(JsonNode r, String unit) { String u = Js.text(r, "unit"); return u != null && u.equals(unit); }
    private static boolean notIs(JsonNode r, String key, String literal) { return !literal.equals(Js.text(r, key)); }

    private static RowScope baseRowScope(String collection, Principal p, RawReader raw, RuleContext ctx) {
        if (isAdmin(p)) return RowScope.ALL;
        String unit = p.unit();
        if (collection.equals("files")) return filesScope(p, raw, ctx);
        if (collection.equals("userProfiles")) return has(p, "MANAGE_USERS") ? RowScope.ALL : RowScope.of((r) -> p.name() != null && p.name().equals(Js.text(r, "userName")));
        if (isResident(p)) {
            switch (collection) {
                case "culturalEvents": case "audits": return RowScope.of((r) -> Js.is(r, "visibility", "Published"));
                case "serviceContacts": return RowScope.of((r) -> notIs(r, "status", "Hidden"));
                case "culturalBrochure": {
                    Set<String> pub = ids(raw.read("culturalEvents"), (e) -> Js.is(e, "visibility", "Published") && Js.is(e, "brochureStatus", "Published") && notIs(e, "showBrochure", "No"));
                    return RowScope.of((r) -> inSet(pub, Js.text(r, "eventId")));
                }
                case "culturalPrograms": case "culturalSevas": case "culturalOfferings": {
                    Set<String> pub = ids(raw.read("culturalEvents"), (e) -> Js.is(e, "visibility", "Published"));
                    return RowScope.of((r) -> inSet(pub, Js.text(r, "eventId")));
                }
                case "dues": case "unitCredits": return RowScope.of((r) -> unitIs(r, unit), new ScopeNode.Eq("unit", unit));   // S.eq('unit', unit || '')
                case "culturalDonations": case "audit": return RowScope.of((r) -> !unit.isEmpty() && unitIs(r, unit), ownUnit(unit));
                case "gatePeople": return RowScope.of((r) -> Js.is(r, "status", "Active") || (!unit.isEmpty() && Js.is(r, "invitedByUnit", unit)));
                case "gatePassTemplates": return RowScope.of((r) -> !Js.truthy(r, "unit") || (!unit.isEmpty() && unitIs(r, unit)));
                case "gateLinks": case "gatePasses": case "gateVisits": case "gateApprovals": case "gateVehicles": case "gateVillaRules":
                    return RowScope.of((r) -> !unit.isEmpty() && unitIs(r, unit), ownUnit(unit));
                case "tickets": {
                    // own unit AND only task types flagged resident-visible (EC/FM tasks, quotes, invoices never reach residents)
                    Set<String> visible = new LinkedHashSet<>();
                    for (JsonNode t : raw.read("taskTypes")) if (Js.truthy(t, "residentVisible")) visible.add(Js.str(t, "name"));
                    ScopeNode sql = new ScopeNode.And(List.of(new ScopeNode.Or(List.of(new ScopeNode.Eq("unit", unit), new ScopeNode.Eq("scope", "Community"))), new ScopeNode.In("taskType", List.copyOf(visible))));
                    return RowScope.of((r) -> (unitIs(r, unit) || Js.is(r, "scope", "Community")) && inSet(visible, Js.text(r, "taskType")), sql);
                }
                case "meetings": return RowScope.of((r) -> notIs(r, "visibility", "Internal (committee only)"));
                case "ticketComments": {
                    Set<String> mine = ids(raw.read("tickets"), (t) -> unitIs(t, unit));
                    return RowScope.of((r) -> inSet(mine, Js.text(r, "ticketId")) && notIs(r, "visibility", "Internal"));
                }
                case "documents": return RowScope.of((r) -> DocGroups.docVisible(r, p, ctx));
                case "users": {
                    Set<String> ecRoles = new LinkedHashSet<>();
                    for (JsonNode r : raw.read("roles")) if (Js.is(r, "category", "EC") && notIs(r, "id", "super_admin")) ecRoles.add(Js.str(r, "id"));
                    return RowScope.of((r) -> {
                        if (!notIs(r, "status", "Inactive")) return false;
                        if (ecRoles.contains(Js.str(r, "roleId")) && Js.has(r, "roleId")) return true;
                        return Js.strings(r, "extraRoleIds").stream().anyMatch(ecRoles::contains);
                    });
                }
                case "broadcasts": return RowScope.of((r) -> Js.is(r, "status", "Sent") && broadcastReaches(r, p));   // only the announcements addressed to them
                case "voteRoll": return RowScope.transform((r) -> with(r, "owner", ""));   // everyone sees WHICH units voted, not the voter's name
                case "pollVotes": return RowScope.transform((r) -> unitIs(r, unit) ? r : withAll(r, "voter", "", "unit", "—"));
                case "amenities":   // availability stays visible (calendar); the booker's identity and money do not
                    return RowScope.transform((r) -> unitIs(r, unit) ? r : amenityStub(r));
                case "amenitySettings": return RowScope.transform((r) -> without(r, "adminRecipients", "reportRecipients"));
                case "properties": return RowScope.transform((r) -> unitIs(r, unit) ? r : directory(r));
                default: return RowScope.ALL;
            }
        }
        if (collection.equals("attendance") && !has(p, "MANAGE_FIELD_DUTIES") && !isEC(p)) return RowScope.of((r) -> p.name() != null && p.name().equals(Js.text(r, "staffName")));   // staff see only their own punches
        if (collection.equals("documents")) return RowScope.of((r) -> DocGroups.docVisible(r, p, ctx));
        if (collection.equals("audit") && !has(p, "VIEW_AUDIT_LOG")) return RowScope.of((r) -> Js.truthy(r, "unit"), new ScopeNode.NotEmpty("unit"));   // unit activity only, never the full log
        return RowScope.ALL;
    }

    /** Uploaded files inherit the visibility of what they are attached to. */
    private static RowScope filesScope(Principal p, RawReader raw, RuleContext ctx) {
        boolean resident = isResident(p);
        Set<String> ownTickets = resident ? ids(raw.read("tickets"), (t) -> unitIs(t, p.unit()) || Js.is(t, "scope", "Community")) : NONE;
        Set<String> ownBookings = resident ? ids(raw.read("amenities"), (b) -> unitIs(b, p.unit())) : NONE;
        Set<String> pubAudits = resident ? ids(raw.read("audits"), (a) -> Js.is(a, "visibility", "Published")) : NONE;
        List<JsonNode> allDocs = raw.read("documents");
        List<JsonNode> folders = raw.read("docFolders");
        Predicate<JsonNode> docOk = (r) -> DocGroups.docVisible(r, p, ctx) && (!Js.truthy(r, "folderId") || folderAllowed(Js.text(r, "folderId"), folders, p));
        Set<String> docIds = new LinkedHashSet<>();
        Set<String> hiddenDocFiles = new LinkedHashSet<>();
        for (JsonNode d : allDocs) {
            String file = Js.text(d, "fileId");
            if (resident && docOk.test(d) && file != null) docIds.add(file);
            if (!docOk.test(d) && file != null) hiddenDocFiles.add(file);   // files of documents this person's group may not open
        }
        Set<String> pubBrochure = resident ? ids(raw.read("culturalEvents"), (e) -> Js.is(e, "visibility", "Published") && Js.is(e, "brochureStatus", "Published") && notIs(e, "showBrochure", "No")) : NONE;
        // meter photos: staff who manage readings, and the owner of the villa once the bill is published to them
        Set<String> ownReadings = new LinkedHashSet<>();
        if (resident) for (JsonNode d : raw.read("dues")) if (unitIs(d, p.unit()) && Js.truthy(d, "readingId")) ownReadings.add(Js.str(d, "readingId"));
        return RowScope.of((r) -> {
            String type = Js.text(r, "ownerType");
            String owner = Js.text(r, "ownerId");
            if (type == null) type = "";
            switch (type) {
                case "ticket": return !resident || inSet(ownTickets, owner);
                case "amenityDeposit": return !resident || inSet(ownBookings, owner);
                case "ticketInternal": return !resident;
                case "quotation": return isQuoteRole(p);
                case "audit": return !resident || inSet(pubAudits, owner);
                case "ledger": return ReadRules.canRead("ledger", p);
                case "culturalExpense": return ReadRules.canRead("culturalExpenses", p);
                case "vendor": return ReadRules.canRead("vendorComments", p);
                case "inventory": return ReadRules.canRead("inventory", p);
                case "reading": return resident ? inSet(ownReadings, owner) : Perms.canManageReadings(p);
                case "meeting": return true;
                case "culturalBrochure": return !resident || inSet(pubBrochure, owner);
                default: { String id = Js.text(r, "id"); return resident ? inSet(docIds, id) : !inSet(hiddenDocFiles, id); }
            }
        });
    }

    // ---- small helpers -------------------------------------------------------------------------------------------------
    private static boolean inSet(Set<String> set, String v) { return v != null && set.contains(v); }
    private static Set<String> ids(List<JsonNode> rows, Predicate<JsonNode> keep) {
        Set<String> out = new LinkedHashSet<>();
        for (JsonNode r : rows) if (keep.test(r)) { String id = Js.text(r, "id"); if (id != null) out.add(id); }
        return out;
    }
    private static ObjectNode copy(JsonNode r) { return r.isObject() ? ((ObjectNode) r).deepCopy() : JsonNodeFactory.instance.objectNode(); }
    private static JsonNode with(JsonNode r, String k, String v) { ObjectNode o = copy(r); o.put(k, v); return o; }
    private static JsonNode withAll(JsonNode r, String k1, String v1, String k2, String v2) { ObjectNode o = copy(r); o.put(k1, v1); o.put(k2, v2); return o; }
    private static JsonNode without(JsonNode r, String... keys) { ObjectNode o = copy(r); o.remove(List.of(keys)); return o; }
    private static JsonNode amenityStub(JsonNode r) {
        ObjectNode o = JsonNodeFactory.instance.objectNode();
        for (String k : new String[]{"id", "amenity", "date", "slot", "status"}) if (Js.has(r, k)) o.set(k, r.get(k));
        o.put("unit", "—");
        if (Js.has(r, "shortId")) o.set("shortId", r.get("shortId"));
        return o;
    }
    private static JsonNode directory(JsonNode r) {
        ObjectNode o = JsonNodeFactory.instance.objectNode();
        for (String k : DIRECTORY_FIELDS) if (Js.has(r, k)) o.set(k, r.get(k));
        for (String k : META_KEYS) if (Js.has(r, k)) o.set(k, r.get(k));
        return o;
    }
}
