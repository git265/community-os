package com.communityos.amenities;

import static com.communityos.amenities.AmenityEngine.inr;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The wording of the booking messages: the events, the starter templates, the {{tokens}} and what they print. A port of the "templates" part of
 * src/lib/amenityEngine.js (EVENTS, defaultTemplates, renderTemplate, bookingVars) and of the tax breakdown line of src/lib/billText.js.
 * India's tax (GST, split into CGST + SGST) and the rupee are fixed here, as in {@link AmenityEngine#inr}.
 */
public final class AmenityTemplates {
    private AmenityTemplates() {}
    private static final JsonNodeFactory F = JsonNodeFactory.instance;

    public static final List<String> CHANNELS = List.of("Email", "SMS", "WhatsApp");
    /** id, label */
    public static final List<String[]> EVENTS = List.of(
            new String[] {"booking_confirmed", "Booking confirmed"},
            new String[] {"booking_pending", "Booking awaiting payment"},
            new String[] {"payment_received", "Payment received"},
            new String[] {"booking_cancelled", "Booking cancelled"},
            new String[] {"refund_processed", "Refund processed"},
            new String[] {"deposit_settled", "Security deposit settled"},
            new String[] {"payment_expired", "Unpaid booking released"},
            new String[] {"reminder", "Booking reminder"},
            new String[] {"daily_report", "Daily report"},
            new String[] {"summary_report", "Summary report"});
    /** The events about one booking (everything but the two reports): these also reach the unit's bell. */
    public static final List<String> BOOKING_EVENTS = EVENTS.stream().map(e -> e[0]).filter(id -> !id.contains("report")).toList();
    /** event id -> the title of the bell notification (reports have none). */
    static final Map<String, String> BELL_TITLES = Map.of("booking_confirmed", "Booking confirmed", "booking_pending", "Booking awaiting payment", "payment_received", "Payment received",
            "booking_cancelled", "Booking cancelled", "refund_processed", "Refund processed", "deposit_settled", "Deposit settled", "payment_expired", "Booking released", "reminder", "Booking reminder");

    private static final Map<String, String> BODY = new LinkedHashMap<>();   // "event|audience" -> text
    private static void put(String event, String audience, String text) { BODY.put(event + "|" + audience, text); }
    static {
        put("booking_confirmed", "Owner", "Hi {{owner}}, your booking {{booking_no}} is confirmed.\n{{amenity}} · {{date}} · {{slot}}\nFee {{taxable}} + {{tax_name}} {{gst}} ({{gst_rate}}) = {{fee}}\n{{tax_breakdown}}\nRefundable deposit {{deposit}}\nTotal paid {{total}} via {{payment_mode}}.\n— {{community}}");
        put("booking_confirmed", "Admin", "New booking {{booking_no}}: {{amenity}} · {{date}} · {{slot}} · {{unit}} ({{owner}})\nFee {{fee}} (GST {{gst}}), deposit {{deposit}}, total {{total}} · {{payment_mode}} · {{payment_status}}");
        put("booking_pending", "Owner", "Hi {{owner}}, booking {{booking_no}} ({{amenity}} · {{date}} · {{slot}}) is reserved. Please pay {{total}} at the office by {{payment_mode}} to confirm it. Fee includes {{tax_name}} {{gst}} ({{gst_rate}}); unpaid reservations are released automatically.");
        put("booking_pending", "Admin", "Payment awaited: {{booking_no}} {{amenity}} · {{date}} · {{unit}} · {{total}} ({{payment_mode}}).");
        put("payment_received", "Owner", "Payment of {{total}} received for booking {{booking_no}} ({{amenity}} · {{date}}). Thank you!");
        put("payment_received", "Admin", "Payment received: {{booking_no}} · {{unit}} · {{total}} ({{payment_mode}}). Taxable {{taxable}}, {{tax_name}} {{gst}}.");
        put("booking_cancelled", "Owner", "Booking {{booking_no}} ({{amenity}} · {{date}} · {{slot}}) is cancelled.\nRefund {{refund}} ({{refund_pct}} of the fee + deposit {{deposit_returned}}). Retained {{retained}}.");
        put("booking_cancelled", "Admin", "Cancelled: {{booking_no}} · {{amenity}} · {{date}} · {{unit}}. Refund {{refund}}, retained {{retained}}. Reason: {{reason}}");
        put("refund_processed", "Owner", "Your refund of {{refund}} for booking {{booking_no}} has been processed.");
        put("refund_processed", "Admin", "Refund processed: {{booking_no}} · {{unit}} · {{refund}}.");
        put("deposit_settled", "Owner", "Security deposit for {{booking_no}}: {{deposit_returned}} returned of {{deposit}}. {{reason}}");
        put("deposit_settled", "Admin", "Deposit settled: {{booking_no}} · {{unit}} · returned {{deposit_returned}} of {{deposit}}. {{reason}}");
        put("payment_expired", "Owner", "Booking {{booking_no}} ({{amenity}} · {{date}}) was released because payment was not received in time.");
        put("payment_expired", "Admin", "Auto-released unpaid booking {{booking_no}} · {{amenity}} · {{date}} · {{unit}}.");
        put("reminder", "Owner", "Reminder: {{amenity}} tomorrow ({{date}}) · {{slot}} for {{unit}}. Booking {{booking_no}}. Please read the rules before use.");
        put("daily_report", "Admin", "{{report}}");
        put("summary_report", "Admin", "{{report}}");
    }

    /** The starter wording, one row per event + channel + audience (SMS ones switched off and cut to two lines; no reports by SMS). */
    public static List<ObjectNode> defaultTemplates() {
        List<ObjectNode> rows = new ArrayList<>();
        for (String[] e : EVENTS) {
            boolean report = e[0].contains("report");
            for (String ch : CHANNELS) for (String aud : List.of("Owner", "Admin")) {
                String text = BODY.get(e[0] + "|" + aud);
                if (text == null || text.isEmpty()) continue;
                if (report && "SMS".equals(ch)) continue;   // SMS stays short: reports go by WhatsApp / e-mail only
                ObjectNode r = F.objectNode();
                r.put("id", ("nt_" + e[0] + "_" + ch + "_" + aud).toLowerCase(Locale.ROOT));
                r.put("event", e[0]); r.put("channel", ch); r.put("audience", aud); r.put("enabled", !"SMS".equals(ch));
                r.put("subject", "Email".equals(ch) ? e[1] + " · {{community}}" + (report ? " · {{report_period}}" : " · {{booking_no}}") : "");
                r.put("body", "SMS".equals(ch) ? firstTwoLines(text) : text);
                rows.add(r);
            }
        }
        return rows;
    }

    private static String firstTwoLines(String text) {
        List<String> keep = new ArrayList<>();
        for (String l : text.split("\n", -1)) if (!l.isEmpty()) keep.add(l);
        return String.join(" ", keep.subList(0, Math.min(2, keep.size())));
    }

    // ---- {{tokens}} ----------------------------------------------------------------------------------------------------

    private static final String SP = "[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*";   // JavaScript's \s
    private static final Pattern TOKEN = Pattern.compile("\\{\\{" + SP + "([a-z_]+)" + SP + "\\}\\}", Pattern.CASE_INSENSITIVE);

    /** `String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, ...)`: a token with no value (or an unknown one) prints as nothing. */
    public static String render(JsonNode text, Map<String, String> vars) {
        Matcher m = TOKEN.matcher(Js.orEmpty(text));
        StringBuilder sb = new StringBuilder();
        while (m.find()) { String v = vars.get(m.group(1)); m.appendReplacement(sb, Matcher.quoteReplacement(v == null ? "" : v)); }
        m.appendTail(sb);
        return sb.toString();
    }
    public static String render(String text, Map<String, String> vars) { return render(F.textNode(text == null ? "" : text), vars); }

    /** `v` as a template value: undefined and null print as nothing (the token is left empty), anything else as JavaScript's String(v). */
    static String val(JsonNode v) { return v == null || v.isMissingNode() || v.isNull() ? null : Js.toStr(v); }

    /** The values for the tokens of one booking. {@code extra} (a few events pass one) wins over the booking's own values. */
    public static Map<String, String> bookingVars(JsonNode b, String community, String owner, String reason, Map<String, String> extra) {
        Map<String, String> v = new LinkedHashMap<>();
        v.put("community", community); v.put("booking_no", Js.orEmpty(Js.f(b, "shortId")));
        v.put("amenity", val(Js.f(b, "amenity"))); v.put("date", val(Js.f(b, "date"))); v.put("slot", val(Js.f(b, "slot"))); v.put("unit", val(Js.f(b, "unit"))); v.put("owner", owner);
        v.put("rate", inr(Js.f(b, "rate"))); v.put("taxable", inr(Js.f(b, "baseAmount")));
        v.put("gst_rate", Js.orEmpty(Js.f(b, "gstRate")).isEmpty() ? "0%" : Js.orEmpty(Js.f(b, "gstRate")) + "%");
        v.put("tax_name", "GST");
        v.put("tax_breakdown", taxBreakdownLine(Js.is(b, "gstMode", "Inclusive") ? Js.f(b, "feeTotal") : Js.f(b, "baseAmount"), Js.f(b, "gstRate"), Js.f(b, "gstMode")));
        v.put("pay_by", ""); v.put("gst", inr(Js.f(b, "gstAmount"))); v.put("fee", inr(Js.f(b, "feeTotal"))); v.put("deposit", inr(Js.f(b, "depositAmount"))); v.put("total", inr(Js.f(b, "totalPayable")));
        v.put("payment_mode", Js.truthy(b, "paymentMode") ? Js.toStr(Js.f(b, "paymentMode")) : "—"); v.put("payment_status", Js.orEmpty(Js.f(b, "paymentStatus")));
        v.put("refund", inr(Js.f(b, "refundAmount")));
        JsonNode pct = Js.f(b, "refundPct");
        v.put("refund_pct", (pct.isMissingNode() || pct.isNull() ? "0" : Js.toStr(pct)) + "%");
        v.put("retained", inr(Js.f(b, "retainedAmount"))); v.put("deposit_returned", inr(Js.f(b, "depositReturned")));
        v.put("reason", reason != null && !reason.isEmpty() ? reason : Js.orEmpty(Js.f(b, "cancelReason"))); v.put("gstin", "");
        if (extra != null) v.putAll(extra);
        return v;
    }

    // ---- the tax line --------------------------------------------------------------------------------------------------

    private static double num0(JsonNode n) { double d = Js.toNumber(n); return Double.isNaN(d) ? 0 : d; }
    /** finance/rules.js r2: `Math.round((Number(n) + Number.EPSILON) * 100) / 100` */
    static double r2(double n) { return AmenityEngine.jsRound((n + 2.220446049250313E-16) * 100) / 100; }
    /** The rupee amount as locale.js money(): whole rupees, Indian grouping. */
    static String money(double n) { return "₹" + AmenityEngine.groupIndian(AmenityEngine.jsRound(Double.isNaN(n) ? 0 : n), 0); }

    /**
     * "GST breakdown: taxable ₹1,000 + CGST 9% ₹90 + SGST 9% ₹90 = ₹1,180", or nothing when there is no tax: billTermsText(...) cut down to its
     * "breakdown" line, as bookingVars does.
     */
    static String taxBreakdownLine(JsonNode amount, JsonNode rate, JsonNode mode) {
        double a = num0(amount), r = num0(rate);
        boolean inclusive = mode != null && mode.isTextual() && "Inclusive".equals(mode.asText());
        double taxable = a, tax = 0, total = a;
        if (r > 0) {
            if (inclusive) { taxable = r2(a / (1 + r / 100)); tax = r2(a - taxable); total = a; }
            else { taxable = a; tax = r2((a * r) / 100); total = r2(a + tax); }
        }
        if (!(tax > 0)) return "";
        double[] shares = {0.5, 0.5};
        String[] labels = {"CGST", "SGST"};
        StringBuilder lines = new StringBuilder();
        for (int i = 0; i < 2; i++) {
            double amt = i == 1 ? r2(tax - r2(tax * shares[0])) : r2(tax * shares[i]);
            double lr = r > 0 ? r2(r * shares[i]) : 0;
            lines.append(" + ").append(labels[i]).append(lr != 0 ? " " + Js.numberToString(lr) + "%" : "").append(' ').append(money(amt));
        }
        return "GST breakdown: taxable " + money(taxable) + lines + " = " + money(total) + (inclusive && r != 0 ? " (tax included in the price)" : "");
    }
}
