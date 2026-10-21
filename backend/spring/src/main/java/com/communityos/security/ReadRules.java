package com.communityos.security;

import static com.communityos.security.Perms.anyPerm;
import static com.communityos.security.Perms.canAssetsRead;
import static com.communityos.security.Perms.canCultural;
import static com.communityos.security.Perms.canManageReadings;
import static com.communityos.security.Perms.canReports;
import static com.communityos.security.Perms.has;
import static com.communityos.security.Perms.isAdmin;
import static com.communityos.security.Perms.isEC;
import static com.communityos.security.Perms.isQuoteRole;
import static com.communityos.security.Perms.isResident;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/** Collection access for reads: may this role open the collection at all? (READ_RULES in src/lib/security/authz.js). Collections not listed are open. */
public final class ReadRules {
    private ReadRules() {}

    /** The collections whose records are asset logs and meter / bill books (readable by everyone on the management side). */
    static final List<String> ASSET_COLLECTIONS = List.of("logEntries", "plantLogs", "dgFuelLogs", "electricityBills", "assocBills", "villaElectricity", "equipment",
            "infraPlans", "infraLayers", "infraLog", "mapVersions");

    /** The finance permissions that open every bill (MANAGE_DUES, MANAGE_UTILITY_BILLING, MANAGE_LEDGER). */
    static final List<String> FINANCE_BILL_PERMS = List.of("MANAGE_DUES", "MANAGE_UTILITY_BILLING", "MANAGE_LEDGER");
    /** A villa's own gate records: visitors, passes, household staff, vehicles, rules, pass presets and the vetted registry. */
    static final List<String> GATE_VILLA_COLLECTIONS = List.of("gatePeople", "gateLinks", "gatePasses", "gateVisits", "gateApprovals", "gateVehicles", "gateVillaRules", "gatePassTemplates");

    private static final Map<String, Predicate<Principal>> RULES = new HashMap<>();
    private static void rule(Predicate<Principal> r, String... collections) { for (String c : collections) RULES.put(c, r); }

    static {
        Predicate<Principal> ecOrLedger = (p) -> isEC(p) || anyPerm(p, "MANAGE_LEDGER");
        Predicate<Principal> ecLedgerBills = (p) -> isEC(p) || anyPerm(p, "MANAGE_LEDGER", "MANAGE_DUES", "MANAGE_UTILITY_BILLING");
        Predicate<Principal> ecFmLedger = (p) -> isEC(p) || "facility_manager".equals(p.roleId()) || anyPerm(p, "MANAGE_LEDGER");
        Predicate<Principal> notResident = (p) -> !isResident(p);
        rule((p) -> isEC(p) || "facility_manager".equals(p.roleId()) || anyPerm(p, "MANAGE_LEDGER", "MANAGE_DUES", "MANAGE_UTILITY_BILLING"), "ledger");
        rule(ecLedgerBills, "funds");
        rule(ecOrLedger, "bankAccounts", "bankTxns", "deposits", "budgetLines", "fixedExpenses");
        rule(Perms::canAssetsRead, ASSET_COLLECTIONS.toArray(new String[0]));
        rule(Perms::canAssetsRead, "villaImportRules");
        rule(notResident, "eventWork");
        rule(Perms::canReports, "reportSchedules", "reportRuns");
        rule(ecFmLedger, "ledgerSkips");
        rule(ecOrLedger, "taxSettings", "taxComponents");
        rule(ecFmLedger, "paymentRouting");
        rule(ecOrLedger, "importProfiles", "financeSettings");
        rule(notResident, "approvalPolicies");
        rule((p) -> isEC(p) || isQuoteRole(p) || anyPerm(p, "MANAGE_LEDGER", "MANAGE_CULTURAL"), "releases");
        rule((p) -> isEC(p) || anyPerm(p, "MANAGE_LEDGER", "MANAGE_DUES"), "levies", "demandNotices", "payRequests", "recurringBills", "cashCounts");
        rule((p) -> !isResident(p) && canCultural(p), "culturalExpenses");
        rule(notResident, "attendance", "attendanceSettings", "workforce", "shifts", "notificationTemplates");
        rule((p) -> isEC(p) || anyPerm(p, "MANAGE_USERS"), "portalInvites");
        rule((p) -> isEC(p) || anyPerm(p, "MANAGE_AMENITIES", "MANAGE_NOTIFICATIONS"), "notificationOutbox");
        rule(notResident, "gateFlags", "gateCheckpoints", "gateRounds", "gateScans", "gateWorkOrders");
        rule((p) -> isEC(p) || has(p, "MANAGE_SECURITY") || has(p, "MANAGE_FIELD_DUTIES"), "incidents");
        rule(notResident, "billingTemplates", "utilityTypes", "logTypes", "categoryMap");
        rule(Perms::isQuoteRole, "quotations");
        rule(notResident, "approverSettings", "vendors");
        rule((p) -> isQuoteRole(p) || has(p, "MANAGE_VENDORS"), "vendorComments");
        rule(notResident, "inventory", "inventoryRules");
        rule(Perms::canManageReadings, "readings");
        // r77: data that belongs to a villa or a person reaches only the people who deal with it
        rule((p) -> isResident(p) || isEC(p) || anyPerm(p, FINANCE_BILL_PERMS) || canManageReadings(p), "dues");
        rule((p) -> isResident(p) || isEC(p) || anyPerm(p, "MANAGE_AMENITIES", "MANAGE_DUES", "MANAGE_UTILITY_BILLING", "MANAGE_LEDGER"), "unitCredits");
        rule((p) -> isResident(p) || isEC(p) || canCultural(p), "culturalDonations");
        rule((p) -> isResident(p) || Perms.gateOrFM(p), GATE_VILLA_COLLECTIONS.toArray(new String[0]));
        rule(Perms::gateOrFM, "gateFlags", "gateWorkOrders");
    }


    /** May this principal read the collection at all? (Row scope and field masking come after.) */
    public static boolean canRead(String collection, Principal p) {
        if (p == null) return false;
        if (isAdmin(p)) return true;
        Predicate<Principal> rule = RULES.get(collection);
        return rule == null || rule.test(p);
    }
}
