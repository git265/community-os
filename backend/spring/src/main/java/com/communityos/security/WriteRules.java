package com.communityos.security;

import static com.communityos.security.Changes.changedKeys;
import static com.communityos.security.Perms.anyPerm;
import static com.communityos.security.Perms.isAdmin;
import static com.communityos.security.Verdict.OK;
import static com.communityos.security.Verdict.deny;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Who may create, change or delete a record: the Java form of authorizeWrite() / canWriteCollection() in src/lib/security/authz.js.
 * A collection has either a CUSTOM rule (fine-grained, below) or a plain permission list (WRITE_RULES). Both give the same answers and
 * the same wording as the web app and the Node reference server; RuleBookConformanceTest replays about 70,000 decisions to prove it.
 */
public final class WriteRules {

    private record Plain(List<String> perms, List<String> categories) {}

    private static final List<String> ADMIN_ONLY = List.of("schema");
    private static final List<String> SYSTEM_ONLY = List.of("audit", "reportRuns", "notificationOutbox", "unitCredits", "portalInvites");

    private static final Map<String, Plain> PLAIN = plain();
    private static void put(Map<String, Plain> t, String collection, List<String> perms, List<String> categories) { t.put(collection, new Plain(perms, categories)); }
    private static Map<String, Plain> plain() {
        Map<String, Plain> t = new HashMap<>();
        put(t, "properties", List.of("MANAGE_UNITS"), List.of());
        put(t, "taskTypes", List.of("MANAGE_TICKET_TYPES"), List.of());
        put(t, "quickPhrases", List.of("MANAGE_TICKETS"), List.of());
        put(t, "tradeAvailability", List.of("MANAGE_TICKETS", "MANAGE_FIELD_DUTIES"), List.of());
        put(t, "handymen", List.of("MANAGE_TICKETS", "MANAGE_FIELD_DUTIES"), List.of("Staff"));
        put(t, "dues", List.of("MANAGE_DUES", "MANAGE_UTILITY_BILLING"), List.of());
        put(t, "funds", List.of("MANAGE_LEDGER"), List.of());
        put(t, "ledger", List.of("MANAGE_LEDGER"), List.of());
        put(t, "bankAccounts", List.of("MANAGE_LEDGER"), List.of());
        put(t, "bankTxns", List.of("MANAGE_LEDGER"), List.of());
        put(t, "deposits", List.of("MANAGE_LEDGER"), List.of());
        put(t, "budgetLines", List.of("MANAGE_LEDGER"), List.of());
        put(t, "fixedExpenses", List.of("MANAGE_LEDGER"), List.of());
        put(t, "ledgerSkips", List.of("MANAGE_LEDGER"), List.of());
        put(t, "taxSettings", List.of("MANAGE_LEDGER"), List.of());
        put(t, "taxComponents", List.of("MANAGE_LEDGER"), List.of());
        put(t, "paymentRouting", List.of("MANAGE_LEDGER"), List.of());
        put(t, "importProfiles", List.of("MANAGE_LEDGER"), List.of());
        put(t, "financeSettings", List.of("MANAGE_LEDGER"), List.of());
        put(t, "approvalPolicies", List.of("MANAGE_LEDGER"), List.of());
        put(t, "releases", List.of("MANAGE_LEDGER"), List.of());
        put(t, "levies", List.of("MANAGE_LEDGER", "MANAGE_DUES"), List.of());
        put(t, "demandNotices", List.of("MANAGE_LEDGER", "MANAGE_DUES"), List.of());
        put(t, "payRequests", List.of("MANAGE_LEDGER"), List.of());
        put(t, "recurringBills", List.of("MANAGE_LEDGER"), List.of());
        put(t, "cashCounts", List.of("MANAGE_LEDGER"), List.of());
        put(t, "billingTemplates", List.of("MANAGE_UTILITY_BILLING"), List.of());
        put(t, "utilityTypes", List.of("MANAGE_UTILITY_TYPES"), List.of());
        put(t, "logTypes", List.of("MANAGE_UTILITY_TYPES"), List.of());
        put(t, "workforce", List.of("MANAGE_FIELD_DUTIES"), List.of());
        put(t, "shifts", List.of("MANAGE_FIELD_DUTIES"), List.of());
        put(t, "culturalEvents", List.of("MANAGE_CULTURAL"), List.of());
        put(t, "culturalExpenses", List.of("MANAGE_CULTURAL", "MANAGE_LEDGER"), List.of());
        put(t, "attendanceSettings", List.of("MANAGE_FIELD_DUTIES"), List.of());
        put(t, "siteCalendar", List.of("MANAGE_FIELD_DUTIES", "MANAGE_SECURITY"), List.of());
        put(t, "siteServices", List.of("MANAGE_FIELD_DUTIES", "MANAGE_SECURITY"), List.of());
        put(t, "siteHolidays", List.of("MANAGE_FIELD_DUTIES", "MANAGE_SECURITY"), List.of());
        put(t, "amenityItems", List.of("MANAGE_AMENITIES", "MANAGE_AMENITY_RATES"), List.of());
        put(t, "amenityTypes", List.of("MANAGE_AMENITIES", "MANAGE_AMENITY_RATES", "MANAGE_AMENITY_RULES"), List.of());
        put(t, "incidents", List.of("MANAGE_SECURITY"), List.of());
        put(t, "vendors", List.of("MANAGE_VENDORS"), List.of());
        put(t, "noticeTemplates", List.of("MANAGE_NOTICE_TEMPLATES"), List.of());
        put(t, "mergeFields", List.of("MANAGE_NOTICE_TEMPLATES"), List.of());
        put(t, "ballots", List.of("MANAGE_GOVERNANCE"), List.of());
        put(t, "meetings", List.of("MANAGE_GOVERNANCE"), List.of());
        put(t, "ecRoles", List.of("MANAGE_GOVERNANCE"), List.of());
        put(t, "subcommittees", List.of("MANAGE_GOVERNANCE"), List.of());
        put(t, "approvals", List.of("MANAGE_GOVERNANCE"), List.of());
        put(t, "documents", List.of("MANAGE_DOCUMENTS"), List.of());
        put(t, "docFolders", List.of("MANAGE_DOCUMENTS"), List.of());
        put(t, "categoryMap", List.of("MANAGE_VENDORS", "MANAGE_TICKET_TYPES"), List.of());
        put(t, "users", List.of("MANAGE_USERS"), List.of());
        put(t, "roles", List.of("MANAGE_ROLES"), List.of());
        put(t, "roleGroups", List.of("MANAGE_ROLES"), List.of());
        return Map.copyOf(t);
    }

    private static Map<String, Rule> custom(Constants k) {
        Map<String, Rule> m = new HashMap<>();
        m.put("gateVisits", GateRules.onlyGateStaff("Only gate staff record entries and exits"));
        m.put("gateFlags", GateRules.onlyGateStaff("Only gate staff handle ghost entry flags"));
        m.put("gateScans", GateRules.onlyGateStaff("Only gate staff record patrol scans"));
        m.put("gateVehicles", GateRules.onlyGateStaff("Only the security team manages the FASTag / plate list"));
        m.put("gatePassTemplates", GateRules::passTemplates);
        m.put("gateSettings", GateRules::settings);
        m.put("gateWorkOrders", GateRules::workOrders);
        m.put("gatePeople", GateRules::people);
        m.put("gateLinks", GateRules::links);
        m.put("gatePasses", GateRules::passes);
        m.put("gateVillaRules", GateRules::villaRules);
        m.put("gateApprovals", GateRules::approvals);
        m.put("ledger", FinanceRules::ledger);
        m.put("culturalSevas", CultureRules.signupGuard("volunteers", "needed"));
        m.put("culturalPrograms", CultureRules.signupGuard("participants", "capacity"));
        m.put("culturalOfferings", CultureRules::offerings);
        m.put("culturalExpenses", FinanceRules::culturalExpenses);
        m.put("attendance", CommunityRules::attendance);
        m.put("culturalDonations", CultureRules::donations);
        m.put("culturalPhotos", CultureRules::photos);
        m.put("tickets", TicketRules::tickets);
        m.put("ticketComments", TicketRules::comments);
        m.put("dues", TicketRules::dues);
        m.put("readings", TicketRules::readings);
        m.put("approverSettings", FinanceRules::approverSettings);
        m.put("culturalEvents", CultureRules::events);
        m.put("quotations", FinanceRules::quotations);
        m.put("releases", FinanceRules::releases);
        m.put("vendorComments", CommunityRules::vendorComments);
        m.put("eventWork", CommunityRules::eventWork);
        m.put("reportSchedules", CommunityRules::reportSchedules);
        m.put("inventory", CommunityRules::inventory);
        m.put("inventoryRules", CommunityRules::inventoryRules);
        for (String a : ReadRules.ASSET_COLLECTIONS) m.put(a, CommunityRules::assets);
        m.put("equipment", CommunityRules::equipment);   // after the loop: the rename rule replaces the plain asset rule
        m.put("pollVotes", CommunityRules::pollVotes);
        m.put("userProfiles", CommunityRules::userProfiles);
        m.put("villaImportRules", CommunityRules::villaImportRules);
        m.put("importProfiles", CommunityRules::importProfiles);
        m.put("files", (c) -> CommunityRules.files(c, k));
        m.put("audits", CommunityRules::audits);
        m.put("serviceContacts", CommunityRules::serviceContacts);
        m.put("contactReviews", CommunityRules::contactReviews);
        m.put("forum", CommunityRules::forum);
        m.put("wishes", CommunityRules::wishes);
        m.put("forumPosts", CommunityRules::forumPosts);
        m.put("amenityTypes", CommunityRules::amenityTypes);
        m.put("amenitySettings", CommunityRules::amenitySettings);
        m.put("notificationTemplates", CommunityRules::notificationTemplates);
        m.put("amenities", CommunityRules::amenities);
        m.put("broadcasts", CommunityRules::broadcasts);
        return Map.copyOf(m);
    }

    private final Map<String, Rule> custom;

    public WriteRules(Constants constants) { this.custom = custom(constants); }

    private static boolean plainAllowed(Plain r, Principal p) { return anyPerm(p, r.perms()) || (r.categories().contains(p.category()) && p.category() != null); }

    /** Decide a write. */
    public Verdict authorize(WriteCall c) {
        Principal p = c.p();
        if (p == null) return deny("Not signed in");
        if (isAdmin(p)) return OK;
        if (ADMIN_ONLY.contains(c.collection())) return deny("Super Admin only");
        if (SYSTEM_ONLY.contains(c.collection())) return deny("System-managed collection");
        Rule rule = custom.get(c.collection());
        if (rule != null) {
            Verdict res = rule.check(c);
            if (res != null && !res.ok()) return res;
            if (res != null) return fieldCheck(c, true);
        } else {
            Plain plain = PLAIN.get(c.collection());
            if (plain != null && !plainAllowed(plain, p)) return deny("Requires permission: " + String.join(" or ", plain.perms()));
        }
        if (c.isDelete()) return OK;
        return fieldCheck(c, false);
    }

    /** editableBy enforcement for updates (creates are gated by collection access). */
    private static Verdict fieldCheck(WriteCall c, boolean skipSchema) {
        if (skipSchema || c.schema() == null || c.old() == null || c.isDelete()) return OK;
        List<String> labels = changedKeys(c.old(), c.next()).stream()
                .map((k) -> c.schema().field(k))
                .flatMap(java.util.Optional::stream)
                .filter((f) -> !f.canEdit(c.p().roleId()))
                .map(Schema.Field::label).toList();
        return labels.isEmpty() ? OK : deny("Your role cannot edit: " + String.join(", ", labels));
    }

    /** For the UI: may this principal write to the collection at all (create)? */
    public boolean canWriteCollection(String collection, Principal p) {
        if (p == null) return false;
        if (isAdmin(p)) return true;
        switch (collection) {
            case "audits": case "inventory": case "inventoryRules": return Perms.isQuoteRole(p);
            case "eventWork": return Perms.canEventWork(p);
            case "reportSchedules": return Perms.canReports(p);
            case "villaImportRules": case "communityConfig": return isAdmin(p);
            case "approverSettings": return Perms.SETTINGS_EDITORS.contains(p.roleId());
            case "readings": return Perms.canManageReadings(p);
            case "vendorComments": return Perms.isQuoteRole(p) || Perms.has(p, "MANAGE_VENDORS");
            default: break;
        }
        if (ReadRules.ASSET_COLLECTIONS.contains(collection)) return Perms.canAssetsWrite(p);
        if (ADMIN_ONLY.contains(collection) || SYSTEM_ONLY.contains(collection)) return false;
        Plain r = PLAIN.get(collection);
        return r == null || plainAllowed(r, p);
    }
}
