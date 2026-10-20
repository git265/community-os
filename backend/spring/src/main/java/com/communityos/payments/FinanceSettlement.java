package com.communityos.payments;

import com.communityos.access.CommunityMeta;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.communityos.service.audit.AuditTrail;
import com.communityos.service.audit.RecordTrail;
import com.communityos.service.audit.Stamps;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The money steps of a settlement, written on the raw collections (no rule book: no signed-in person is involved, the signed webhook is the
 * authority). They port src/lib/finance/settle.js (settleDues), rules.js (applyCredits, creditBalance), utilityLedger.js (syncDuePayment) and the
 * donation receipt of lib/payments.js. EVERY method must run inside the caller's transaction (PaymentService.settle), which is what makes
 * bill + credit + ledger line + receipt all-or-nothing.
 *
 * Differences from the Node original, on purpose: a changed bill gets recVersion + 1, so a screen holding the old copy gets a 409 instead of
 * silently un-paying it; the donation's mode is "Online" (the Node demo wrote "Online (demo)").
 */
public class FinanceSettlement {
    public static final String SYSTEM = "System · payment gateway";
    private static final Set<String> FINANCE_KINDS = Set.of("Advance", "Credit note", "Applied");
    private static final Set<String> CLOSED = Set.of("Paid", "Cancelled");
    private static final Pattern DUE_PREFIX = Pattern.compile("^DUE-");

    private final DocumentRepository repo;
    private final AuditTrail audit;
    private final ObjectMapper json;
    private final Clock clock;
    private final Constants constants;

    public FinanceSettlement(DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, Constants constants) {
        this.repo = repo; this.audit = audit; this.json = json; this.clock = clock; this.constants = constants;
    }

    public Constants constants() { return constants; }

    private static Principal system() { return new Principal("system", new Principal.Role("system", SYSTEM, "System", Set.of()), SYSTEM, "", List.of()); }

    public static double r2(double n) { return BigDecimal.valueOf(n).setScale(2, RoundingMode.HALF_UP).doubleValue(); }

    /** JS prints 1000 and 1000.5, never 1000.0. */
    public static String show(double n) { return n == Math.rint(n) && Math.abs(n) < 1e15 ? String.valueOf((long) n) : BigDecimal.valueOf(n).stripTrailingZeros().toPlainString(); }

    private String today() { return LocalDate.now(clock.withZone(ZoneId.systemDefault())).toString(); }

    // ---- credit ---------------------------------------------------------------------------------------------------------

    /** Every row of the unit, whatever its kind (what the payer sees as "your credit"). */
    public static double creditBalance(List<JsonNode> rows, String unit) {
        double sum = 0;
        for (JsonNode r : rows) if (unit.equals(Js.str(Js.f(r, "unit")))) sum += ("Credit".equals(Js.str(Js.f(r, "type"))) ? 1 : -1) * Js.number(r, "amount");
        return r2(sum);
    }

    private Map<String, Double> creditBalances(String tenant) {
        Map<String, Double> by = new HashMap<>();
        for (JsonNode r : repo.list(tenant, "unitCredits")) {
            if (!FINANCE_KINDS.contains(Js.str(Js.f(r, "kind")))) continue;
            by.merge(Js.str(Js.f(r, "unit")), r2(("Credit".equals(Js.str(Js.f(r, "type"))) ? 1 : -1) * Js.number(r, "amount")), (a, b) -> r2(a + b));
        }
        return by;
    }

    /** Use each unit's credit on its unpaid bills, oldest first. A bill is cleared when the credit covers it, otherwise reduced. */
    public int applyCredits(String tenant, Set<String> units, Set<String> only) {
        Map<String, Double> bal = creditBalances(tenant);
        Map<String, List<JsonNode>> byUnit = new java.util.LinkedHashMap<>();
        for (JsonNode d : duesToConsider(tenant, only)) {
            String unit = Js.str(Js.f(d, "unit"));
            if (CLOSED.contains(Js.str(Js.f(d, "status"))) || !(Js.number(d, "amount") > 0) || unit.isEmpty() || (only != null && !only.contains(Js.str(Js.f(d, "id"))))) continue;
            byUnit.computeIfAbsent(unit, k -> new ArrayList<>()).add(d);
        }
        String now = Stamps.iso(clock), day = today();
        List<JsonNode> updates = new ArrayList<>();
        List<ObjectNode> debits = new ArrayList<>();
        for (var e : byUnit.entrySet()) {
            String unit = e.getKey();
            if (units != null && !units.contains(unit)) continue;
            double credit = bal.getOrDefault(unit, 0.0);
            if (!(credit > 0)) continue;
            List<JsonNode> list = e.getValue();
            list.sort(Comparator.comparing(d -> Js.str(Js.f(d, "dueDate"))));
            for (JsonNode d : list) {
                if (!(credit > 0.004)) break;
                double amount = Js.number(d, "amount");
                double use = Math.min(credit, amount);
                credit = r2(credit - use);
                boolean full = use >= amount - 0.004;
                double gross = Js.number(d, "grossAmount") != 0 ? Js.number(d, "grossAmount") : amount;
                ObjectNode n = ((ObjectNode) d).deepCopy();
                n.put("grossAmount", gross).put("creditApplied", r2(Js.number(d, "creditApplied") + use)).put("amount", full ? amount : r2(amount - use));
                if (full) n.put("status", "Paid").put("paymentMode", "Unit credit").put("paymentRef", "CREDIT").put("paidAt", day).put("paidBy", SYSTEM).put("receiptNo", receiptNo(d));
                n.put("recVersion", (long) Js.number(d, "recVersion") + 1).put("lastUpdatedAt", now).put("lastUpdatedBy", SYSTEM);
                updates.add(n);
                debits.add(json.createObjectNode().put("unit", unit).put("type", "Debit").put("amount", use)
                        .put("reason", (full ? "Paid" : "Part-paid") + " bill " + Js.str(Js.f(d, "shortId")) + " from credit").put("kind", "Applied").put("billNo", Js.str(Js.f(d, "shortId"))));
            }
        }
        if (updates.isEmpty()) return 0;
        repo.upsertAll(tenant, "dues", updates);
        for (ObjectNode row : debits) {
            row.put("id", UUID.randomUUID().toString()).put("shortId", nextShortId(tenant, "unitCredits")).put("date", day).put("recVersion", 1)
                    .put("recordCreatedAt", now).put("recordCreatedBy", SYSTEM).put("lastUpdatedAt", now).put("lastUpdatedBy", SYSTEM);
            repo.upsert(tenant, "unitCredits", row.get("id").asText(), row);
        }
        long unitCount = debits.stream().map(x -> x.get("unit").asText()).distinct().count();
        event(tenant, "Billing & Finance", "Update", "", "Unit credit used on " + updates.size() + " bill(s) for " + unitCount + " unit(s)");
        return updates.size();
    }

    /** Asked-for bills are read by id; only "every unit's credit" has to look at all bills. */
    private List<JsonNode> duesToConsider(String tenant, Set<String> only) {
        if (only == null) return repo.list(tenant, "dues");
        List<JsonNode> out = new ArrayList<>();
        for (String id : only) repo.get(tenant, "dues", id).ifPresent(out::add);
        return out;
    }

    private String receiptNo(JsonNode due) {
        String s = DUE_PREFIX.matcher(Js.str(Js.f(due, "shortId"))).replaceFirst("");
        return "RCT-" + (s.isEmpty() ? String.valueOf(clock.millis()) : s);
    }

    // ---- bills ----------------------------------------------------------------------------------------------------------

    /** Mark the bills paid (credit first, when asked). Bills already paid are skipped, so running it twice is safe. */
    public List<JsonNode> settleDues(String tenant, CommunityMeta meta, List<String> dueIds, String unit, boolean useCredit, String mode, String reference, String paidBy) {
        Set<String> ids = new LinkedHashSet<>(dueIds);
        repo.lock(tenant, "dues", new java.util.TreeSet<>(ids));
        if (useCredit && unit != null && !unit.isEmpty()) applyCredits(tenant, Set.of(unit), ids);
        String stamp = Stamps.iso(clock), day = today();
        List<JsonNode> paid = new ArrayList<>();
        for (JsonNode d : duesToConsider(tenant, ids)) {
            if (CLOSED.contains(Js.str(Js.f(d, "status")))) continue;
            ObjectNode n = ((ObjectNode) d).deepCopy();
            n.put("status", "Paid").put("paymentMode", mode).put("paymentRef", reference == null || reference.isEmpty() ? "—" : reference).put("paidAt", day).put("paidBy", paidBy)
                    .put("receiptNo", receiptNo(d)).put("recVersion", (long) Js.number(d, "recVersion") + 1).put("lastUpdatedAt", stamp).put("lastUpdatedBy", SYSTEM);
            n.setAll(RecordTrail.of(json, d, n, meta.catalog().schema("dues"), stamp, SYSTEM));
            paid.add(n);
        }
        if (!paid.isEmpty()) {
            repo.upsertAll(tenant, "dues", paid);
            double total = r2(paid.stream().mapToDouble(d -> Js.number(d, "amount")).sum());
            event(tenant, "Billing & Finance", "Update", unit, paid.size() + " bill(s) paid online (" + mode + ", ref " + reference + ") · " + show(total));
        }
        return paid;
    }

    /** Post (or update, or remove) the payment-ledger line of one bill. @return the entry, or null when there is none */
    public JsonNode syncDuePayment(String tenant, CommunityMeta meta, JsonNode due, String actor) {
        String dueId = Js.str(Js.f(due, "id"));
        if (dueId.isEmpty()) return null;
        String sid = "due:" + dueId;
        JsonNode existing = null;
        for (JsonNode l : repo.list(tenant, "ledger")) if (sid.equals(Js.str(Js.f(l, "sourceId")))) { existing = l; break; }
        if (!"Paid".equals(Js.str(Js.f(due, "status"))) || "Unit credit".equals(Js.str(Js.f(due, "paymentMode")))) {   // paid from the unit's own credit: the cash was booked when the advance arrived
            if (existing != null) repo.delete(tenant, "ledger", Js.str(Js.f(existing, "id")));
            return null;
        }
        String now = Stamps.iso(clock);
        String category = Js.str(Js.f(due, "category"));
        boolean util = meta.ctx().utilityNames().contains(category);
        JsonNode levy = null;
        String levyId = Js.str(Js.f(due, "levyId"));
        if (!levyId.isEmpty()) for (JsonNode l : repo.list(tenant, "levies")) if (levyId.equals(Js.str(Js.f(l, "id")))) { levy = l; break; }
        ObjectNode row = existing == null ? json.createObjectNode() : ((ObjectNode) existing).deepCopy();
        String paidAt = Js.str(Js.f(due, "paidAt")), dueDate = Js.str(Js.f(due, "dueDate"));
        String date = (!paidAt.isEmpty() ? paidAt : !dueDate.isEmpty() ? dueDate : now);
        date = date.length() > 10 ? date.substring(0, 10) : date;
        String month = Js.str(Js.f(due, "billedMonth")), unit = Js.str(Js.f(due, "unit")), shortId = Js.str(Js.f(due, "shortId"));
        String prevSub = existing == null ? "" : Js.str(Js.f(existing, "subCategory"));
        String id = existing != null ? Js.str(Js.f(existing, "id")) : UUID.randomUUID().toString();
        String account = existing != null && !Js.str(Js.f(existing, "account")).isEmpty() ? Js.str(Js.f(existing, "account")) : (util ? "Electricity/Water/Tax" : "Maintenance");
        row.put("id", id).put("date", date).put("account", account).put("description", category + " bill" + (month.isEmpty() ? "" : " · " + month) + " · " + unit)
                .put("category", category).put("type", "Credit").put("amount", Js.number(due, "amount")).put("vendor", "")
                .put("module", util ? "Utilities" : "Dues").put("sourceType", "due").put("sourceId", sid).put("sourceLabel", (shortId + " · " + category + " · " + unit).trim());
        String fund = levy != null && !Js.str(Js.f(levy, "fund")).isEmpty() ? Js.str(Js.f(levy, "fund")) : existing != null ? Js.str(Js.f(existing, "fund")) : "";
        row.put("fund", fund).put("subCategory", levy != null ? "Levy › " + Js.str(Js.f(levy, "name")) : prevSub)
                .put("unit", unit).put("billNo", shortId).put("mode", Js.str(Js.f(due, "paymentMode"))).put("ref", Js.str(Js.f(due, "paymentRef")))
                .put("reconStatus", existing != null && !Js.str(Js.f(existing, "reconStatus")).isEmpty() ? Js.str(Js.f(existing, "reconStatus")) : "Unreconciled");
        if (existing == null || !Js.f(existing, "attachments").isArray()) row.set("attachments", json.createArrayNode());
        row.put("shortId", existing != null && !Js.str(Js.f(existing, "shortId")).isEmpty() ? Js.str(Js.f(existing, "shortId")) : nextShortId(tenant, "ledger"));
        row.put("recVersion", (existing == null ? 0 : (long) Js.number(existing, "recVersion")) + 1)
                .put("recordCreatedAt", existing != null && !Js.str(Js.f(existing, "recordCreatedAt")).isEmpty() ? Js.str(Js.f(existing, "recordCreatedAt")) : now)
                .put("recordCreatedBy", existing != null && !Js.str(Js.f(existing, "recordCreatedBy")).isEmpty() ? Js.str(Js.f(existing, "recordCreatedBy")) : actor)
                .put("lastUpdatedAt", now).put("lastUpdatedBy", actor);
        if (existing != null && Js.number(existing, "amount") == row.get("amount").asDouble() && Js.str(Js.f(existing, "date")).equals(date)
                && Js.str(Js.f(existing, "mode")).equals(row.get("mode").asText())) return existing;
        JsonNode saved = repo.upsert(tenant, "ledger", id, row);
        audit.write(tenant, audit.entry(system(), "Payments Cross-check", "ledger", id, row.get("shortId").asText(), unit, existing != null ? "Update" : "Create",
                row.get("description").asText() + " · ₹" + show(row.get("amount").asDouble()), null));
        return saved;
    }

    // ---- donations ------------------------------------------------------------------------------------------------------

    /** A pledge paid online: Received, with a receipt number, and the event's totals brought up to date. */
    public void receiveDonation(String tenant, String donationId, String paymentId, String payer) {
        JsonNode d = repo.get(tenant, "culturalDonations", donationId).orElse(null);
        JsonNode ev = d == null ? null : repo.get(tenant, "culturalEvents", Js.str(Js.f(d, "eventId"))).orElse(null);
        if (d == null || ev == null || "Received".equals(Js.str(Js.f(d, "status")))) return;
        String now = Stamps.iso(clock);
        String receipt = !Js.str(Js.f(d, "receiptNo")).isEmpty() ? Js.str(Js.f(d, "receiptNo")) : nextReceiptNo(tenant, ev);
        String gatewayRef = paymentId == null || paymentId.isEmpty() ? "ONLINE" + Long.toString(clock.millis(), 36).toUpperCase() : paymentId;
        ObjectNode n = ((ObjectNode) d).deepCopy();
        n.put("status", "Received").put("receiptNo", receipt).put("mode", "Online").put("reference", !Js.str(Js.f(d, "reference")).isEmpty() ? Js.str(Js.f(d, "reference")) : gatewayRef)
                .put("gatewayRef", gatewayRef).put("date", today()).put("recVersion", (long) Js.number(d, "recVersion") + 1).put("lastUpdatedAt", now).put("lastUpdatedBy", SYSTEM);
        repo.upsert(tenant, "culturalDonations", donationId, n);
        recomputeEventTotals(tenant, ev);
        audit.write(tenant, audit.entry(system(), "Cultural Donations", "culturalDonations", donationId, Js.str(Js.f(d, "shortId")), Js.str(Js.f(d, "unit")), "Update",
                "Online payment of ₹" + show(Js.number(d, "amount")) + " received · receipt " + receipt, null));
    }

    /** <EVENT-CODE>-0001 (code = initials of the event name + year). */
    String nextReceiptNo(String tenant, JsonNode ev) {
        StringBuilder code = new StringBuilder();
        String name = Js.truthy(Js.f(ev, "name")) ? Js.str(Js.f(ev, "name")) : "EVT";
        for (String w : name.trim().split("\\s+")) if (w.matches(".*[A-Za-z].*")) code.append(Character.toUpperCase(w.charAt(0)));
        String start = Js.str(Js.f(ev, "startDate"));
        String c = (code.length() > 4 ? code.substring(0, 4) : code.toString()) + (start.length() >= 4 ? start.substring(2, 4) : "");
        long max = 0;
        for (JsonNode r : repo.list(tenant, "culturalDonations")) {
            if (!Js.str(Js.f(r, "eventId")).equals(Js.str(Js.f(ev, "id"))) || Js.str(Js.f(r, "receiptNo")).isEmpty()) continue;
            String rn = Js.str(Js.f(r, "receiptNo"));
            double n = Js.toNumber(json.getNodeFactory().textNode(rn.substring(rn.lastIndexOf('-') + 1)));
            if (!Double.isNaN(n) && n > max) max = (long) n;
        }
        return c + "-" + String.format("%04d", max + 1);
    }

    private void recomputeEventTotals(String tenant, JsonNode ev) {
        String eid = Js.str(Js.f(ev, "id"));
        double collected = 0, pledged = 0, spent = 0;
        Set<String> families = new HashSet<>(), donors = new HashSet<>();
        for (JsonNode d : repo.list(tenant, "culturalDonations")) {
            if (!eid.equals(Js.str(Js.f(d, "eventId")))) continue;
            String who = Js.truthy(Js.f(d, "unit")) ? Js.str(Js.f(d, "unit")) : Js.str(Js.f(d, "donor"));
            families.add(who);
            String st = Js.str(Js.f(d, "status"));
            if ("Received".equals(st)) { collected += Js.number(d, "amount"); donors.add(who); }
            if ("Pledged".equals(st)) pledged += Js.number(d, "amount");
        }
        for (JsonNode x : repo.list(tenant, "culturalExpenses")) {
            String st = Js.str(Js.f(x, "status"));
            if (eid.equals(Js.str(Js.f(x, "eventId"))) && ("Approved".equals(st) || "Paid".equals(st))) spent += Js.number(x, "amount");
        }
        if (Js.number(ev, "collected") == collected && Js.number(ev, "pledged") == pledged && Js.number(ev, "donors") == donors.size()
                && Js.number(ev, "families") == families.size() && Js.number(ev, "spent") == spent) return;
        ObjectNode n = ((ObjectNode) ev).deepCopy();
        n.put("collected", collected).put("pledged", pledged).put("families", families.size()).put("donors", donors.size()).put("spent", spent)
                .put("recVersion", (long) Js.number(ev, "recVersion") + 1).put("lastUpdatedAt", Stamps.iso(clock));
        if (!Js.truthy(Js.f(ev, "lastUpdatedBy"))) n.put("lastUpdatedBy", SYSTEM);
        repo.upsert(tenant, "culturalEvents", eid, n);
    }

    // ---- helpers --------------------------------------------------------------------------------------------------------

    private String nextShortId(String tenant, String collection) {
        return constants.shortPrefix(collection) + "-" + String.format("%04d", repo.nextShortNumber(tenant, collection, 0));
    }

    private void event(String tenant, String what, String action, String unit, String summary) {
        audit.write(tenant, audit.entry(system(), what, "", "", "", unit, action, summary, null));
    }
}
