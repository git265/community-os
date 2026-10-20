package com.communityos.finance;

import com.communityos.port.GstProvider;
import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Input tax credit check: has each vendor really filed the GST we are claiming? Three layers, cheapest first: the vendor's GSTIN is present and valid (format and
 * the official check character), the invoice has what the GST portal matches on (bill number, date, tax amount), and the invoice shows in the GSTR-2B statement
 * (asked of the GstProvider). A port of src/lib/finance/itc.js. The background job runs it once a day, only for a society registered for GST that switched
 * the automatic check on.
 */
public class ItcJob {
    public static final String NONE = "Not checked", OK = "Verified", GSTIN = "Check vendor GSTIN", DETAILS = "Invoice details missing", MISSING = "Not found in GSTR-2B", NA = "Not applicable";
    public static final String SYSTEM = "System · background check";
    private static final String CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    private static final Pattern GSTIN_FORMAT = Pattern.compile("^\\d{2}[A-Z]{5}\\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$");

    public record Gstin(boolean ok, String reason) {}
    public record Result(String status, String note) {}
    public record Counts(int checked, int ok, int attention) {}

    private final SystemWriter w;
    private final GstProvider gst;

    public ItcJob(SystemWriter w, GstProvider gst) { this.w = w; this.gst = gst; }

    public static Gstin validateGstin(JsonNode g) {
        String s = Js.trim(Js.orEmpty(g)).toUpperCase(java.util.Locale.ROOT);
        if (s.isEmpty()) return new Gstin(false, "No GSTIN on the vendor record");
        if (!GSTIN_FORMAT.matcher(s).matches()) return new Gstin(false, "GSTIN is not in the right format (15 characters)");
        int sum = 0;
        for (int i = 0; i < 14; i++) { int p = CHARS.indexOf(s.charAt(i)) * (i % 2 == 0 ? 1 : 2); sum += p / 36 + (p % 36); }
        char check = CHARS.charAt((36 - (sum % 36)) % 36);
        return check == s.charAt(14) ? new Gstin(true, "") : new Gstin(false, "GSTIN check character does not match: likely a typing mistake");
    }

    /** Is this payment one that carries input credit we would claim? */
    public static boolean carriesCredit(JsonNode l) { return Js.is(l, "type", "Debit") && Js.number(l, "gstAmount") > 0 && !Js.truthy(l, "reversalOf"); }

    public Result checkLine(JsonNode line, List<JsonNode> vendors, boolean registered) {
        if (!registered) return new Result(NA, "The society is not registered for GST, so no input credit is claimed.");
        JsonNode v = null;
        for (JsonNode x : vendors) if (Js.strictEq(Js.f(x, "name"), Js.f(line, "vendor"))) { v = x; break; }
        Gstin g = validateGstin(Js.f(v, "gstin"));
        if (!Js.truthy(line, "vendor")) return new Result(DETAILS, "No vendor chosen on this payment.");
        if (!g.ok()) return new Result(GSTIN, g.reason());
        JsonNode invoiceNo = Js.truthy(line, "invoiceNo") ? Js.f(line, "invoiceNo") : Js.f(line, "billNo");
        if (Js.trim(Js.orEmpty(invoiceNo)).isEmpty()) return new Result(DETAILS, "Add the vendor’s invoice number so it can be matched on the GST portal.");
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("vendorGstin", Js.toStr(Js.f(v, "gstin"))); q.put("invoiceNo", Js.toStr(invoiceNo)); q.put("invoiceDate", Js.str(Js.f(line, "date"))); q.put("gstAmount", Js.str(Js.f(line, "gstAmount")));
        Map<String, Object> r = gst.lookupInvoice(q);
        boolean found = Boolean.TRUE.equals(r.get("found"));
        if (found && Boolean.FALSE.equals(r.get("amountMatches"))) return new Result(DETAILS, "The vendor filed this invoice with a different tax amount. Ask them to correct it.");
        if (found) { Object filedOn = r.get("filedOn"); return new Result(OK, filedOn != null && !String.valueOf(filedOn).isEmpty() ? "Vendor filed on " + filedOn : "Invoice found in the vendor’s filing"); }
        return new Result(MISSING, "The vendor has not shown this invoice in their GST filing. Ask them to file it, or the credit may be lost.");
    }

    /** Check payment lines and save the result on each. @param only "pending" (never checked or needing another look) or "all" */
    public Counts runChecks(String tenant, String actor, String only) {
        List<JsonNode> ledger = w.repo().list(tenant, "ledger"), vendors = w.repo().list(tenant, "vendors"), settings = w.repo().list(tenant, "taxSettings");
        boolean registered = (Js.truthy(settings.isEmpty() ? Js.MISSING : Js.f(settings.get(0), "registered")) ? Js.toStr(Js.f(settings.get(0), "registered")) : "No").equals("Yes");
        List<JsonNode> todo = new ArrayList<>();
        for (JsonNode l : ledger) {
            if (!carriesCredit(l)) continue;
            String st = Js.str(Js.f(l, "itcStatus"));
            if (only.equals("all") || !Js.truthy(l, "itcStatus") || List.of(NONE, MISSING, GSTIN, DETAILS).contains(st) && Js.f(l, "itcStatus").isTextual()) todo.add(l);
        }
        String now = w.now();
        int checked = 0, ok = 0, attention = 0;
        for (JsonNode l : todo) {
            Result r = checkLine(l, vendors, registered);
            ObjectNode n = ((ObjectNode) l).deepCopy();
            n.put("itcStatus", r.status()).put("itcNote", r.note()).put("itcCheckedAt", now);
            w.repo().upsert(tenant, "ledger", Js.str(Js.f(l, "id")), n);
            checked++;
            if (r.status().equals(OK) || r.status().equals(NA)) ok++; else attention++;
        }
        if (checked > 0) w.event(tenant, actor, "Billing & Finance", "Update", "", "GST input credit check: " + checked + " payment(s) checked, " + attention + " need attention");
        return new Counts(checked, ok, attention);
    }

    /** Background: once a day, only when the society is registered and has switched the automatic check on. @return null when nothing was due */
    public Counts runAuto(String tenant) {
        List<JsonNode> rows = w.repo().list(tenant, "taxSettings");
        if (rows.isEmpty()) return null;
        JsonNode s = rows.get(0);
        if (!Js.is(s, "registered", "Yes") || (Js.f(s, "itcAuto").isBoolean() && !Js.f(s, "itcAuto").asBoolean())) return null;
        String today = w.now().substring(0, 10);
        String last = Js.orEmpty(Js.f(s, "itcLastRun"));
        if ((last.length() > 10 ? last.substring(0, 10) : last).equals(today)) return null;
        Counts res = runChecks(tenant, SYSTEM, "pending");
        ObjectNode n = ((ObjectNode) s).deepCopy();
        n.put("itcLastRun", w.now());
        w.repo().upsert(tenant, "taxSettings", Js.str(Js.f(s, "id")), n);
        return res;
    }
}
