package com.communityos.amenities;

import static com.communityos.amenities.AmenityEngine.inr;
import static com.communityos.amenities.AmenityEngine.round2;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

/** The daily and summary reports: plain text that reads the same in WhatsApp, SMS and e-mail. A port of moneyTotals / buildReport / addDays in src/lib/amenityEngine.js. */
public final class AmenityReports {
    private AmenityReports() {}

    public record Money(double depositsReturned, double waived, int waivedCount, int bookingsPaid, double taxable, double gst, double fees, double deposits, double collected,
                        double refunds, double retained, double net) {}
    public record Counts(int pending, int refundDue, int held) {}
    public record Report(String subject, String text, Money money, Counts counts) {}

    private static String dayOf(JsonNode s) { String t = Js.orEmpty(s); return t.length() > 10 ? t.substring(0, 10) : t; }
    private static double n0(JsonNode n) { double d = Js.toNumber(n); return Double.isNaN(d) ? 0 : d; }

    /**
     * `new Date(`${d}T12:00:00`)` (local noon), `setDate(getDate() + n)`, then the UTC date of that moment: the date n days from d.
     * Local time on purpose: it is the community's time zone the JavaScript server ran in.
     */
    public static String addDays(String d, int n, ZoneId zone) {
        LocalDateTime noon = LocalDate.parse(d).plusDays(n).atTime(12, 0);
        return noon.atZone(zone).toInstant().atOffset(ZoneOffset.UTC).toLocalDate().toString();
    }

    private static boolean inRange(JsonNode d, String from, String to) { return Js.truthy(d) && dayOf(d).compareTo(from) >= 0 && dayOf(d).compareTo(to) <= 0; }
    private static double sum(List<JsonNode> l, String k) { double s = 0; for (JsonNode b : l) s += n0(Js.f(b, k)); return round2(s); }
    private static List<JsonNode> where(List<JsonNode> in, Predicate<JsonNode> p) { List<JsonNode> out = new ArrayList<>(); for (JsonNode b : in) if (p.test(b)) out.add(b); return out; }

    /** Money columns for a set of bookings, by the day the money moved (paidAt / cancelledAt). */
    public static Money moneyTotals(List<JsonNode> bookings, String from, String to) {
        List<JsonNode> paid = where(bookings, b -> inRange(Js.f(b, "paidAt"), from, to));
        List<JsonNode> refunded = where(bookings, b -> inRange(Js.f(b, "cancelledAt"), from, to) && Js.toNumber(Js.f(b, "refundAmount")) > 0);
        List<JsonNode> retainedCancel = where(bookings, b -> inRange(Js.f(b, "cancelledAt"), from, to));
        // deposits handed back after the event (a cancelled booking's deposit is already inside its refund)
        List<JsonNode> settled = where(bookings, b -> !Js.is(b, "status", "Cancelled") && inRange(Js.f(b, "depositSettledAt"), from, to) && Js.toNumber(Js.f(b, "depositReturned")) > 0);
        List<JsonNode> waived = where(bookings, b -> Js.truthy(b, "chargeWaived") && inRange(Js.f(b, "recordCreatedAt"), from, to));
        double depositsReturned = sum(settled, "depositReturned");
        return new Money(depositsReturned, sum(waived, "waivedAmount"), waived.size(), paid.size(), sum(paid, "baseAmount"), sum(paid, "gstAmount"), sum(paid, "feeTotal"), sum(paid, "depositAmount"),
                round2(sum(paid, "feeTotal") + sum(paid, "depositAmount")), sum(refunded, "refundAmount"), sum(retainedCancel, "retainedAmount"),
                round2(sum(paid, "feeTotal") + sum(paid, "depositAmount") - sum(refunded, "refundAmount") - depositsReturned));
    }

    /** @param kind "daily" or "summary" */
    public static Report build(String kind, List<JsonNode> bookings, String community, String from, String to, String today, ZoneId zone) {
        Predicate<JsonNode> active = b -> !Js.is(b, "status", "Cancelled");
        List<String> lines = new ArrayList<>();
        Money money = moneyTotals(bookings, from, to);
        boolean daily = "daily".equals(kind);
        String head = daily ? community + " · Amenity daily report · " + today : community + " · Amenity summary · " + from + " to " + to;
        lines.add("*" + head + "*");
        // (the community's tax number line is left out: this server holds none - see docs/BACKEND.md)
        lines.add("");
        if (daily) {
            List<JsonNode> todayB = where(bookings, b -> active.test(b) && Js.is(b, "date", today));
            todayB.sort((a, b) -> IcuCompare.compare(Js.toStr(Js.f(a, "slot")), Js.toStr(Js.f(b, "slot"))));
            String tmr = addDays(today, 1, zone);
            List<JsonNode> tmrB = where(bookings, b -> active.test(b) && Js.is(b, "date", tmr));
            tmrB.sort((a, b) -> IcuCompare.compare(Js.toStr(Js.f(a, "slot")), Js.toStr(Js.f(b, "slot"))));
            lines.add("*Today (" + todayB.size() + ")*");
            for (JsonNode b : todayB) lines.add("• " + Js.toStr(Js.f(b, "amenity")) + " · " + Js.toStr(Js.f(b, "slot")) + " · " + Js.toStr(Js.f(b, "unit")) + " · " + Js.orEmpty(Js.f(b, "paymentStatus")));
            if (todayB.isEmpty()) lines.add("• No bookings");
            lines.add("");
            lines.add("*Tomorrow " + tmr + " (" + tmrB.size() + ")*");
            for (JsonNode b : tmrB) lines.add("• " + Js.toStr(Js.f(b, "amenity")) + " · " + Js.toStr(Js.f(b, "slot")) + " · " + Js.toStr(Js.f(b, "unit")));
            if (tmrB.isEmpty()) lines.add("• No bookings");
            lines.add("");
            long made = bookings.stream().filter(b -> dayOf(Js.f(b, "recordCreatedAt")).equals(today)).count();
            long cancelled = bookings.stream().filter(b -> dayOf(Js.f(b, "cancelledAt")).equals(today)).count();
            lines.add("New bookings today: " + made + " · Cancellations: " + cancelled);
        } else {
            // the distinct amenity names, in order of first appearance (a Set keeps 1 and "1" apart: so does the key)
            Set<String> seen = new LinkedHashSet<>();
            List<JsonNode> names = new ArrayList<>();
            for (JsonNode b : bookings) { JsonNode a = Js.f(b, "amenity"); if (seen.add(kindOf(a) + Js.toStr(a))) names.add(a); }
            lines.add("*By amenity*");
            for (JsonNode n : names) {
                List<JsonNode> rows = where(bookings, b -> Js.strictEq(Js.f(b, "amenity"), n) && gte(Js.f(b, "date"), from) && lte(Js.f(b, "date"), to));
                long act = rows.stream().filter(active).count();
                lines.add("• " + Js.toStr(n) + ": " + act + " booking" + (act == 1 ? "" : "s") + ", " + (rows.size() - act) + " cancelled");
            }
            lines.add("");
        }
        List<JsonNode> pending = where(bookings, b -> Js.is(b, "paymentStatus", "Pending") && active.test(b));
        List<JsonNode> refundDue = where(bookings, b -> Js.is(b, "refundStatus", "Refund due"));
        List<JsonNode> held = where(bookings, b -> Js.is(b, "depositStatus", "Held"));
        lines.add("*Payments " + (daily ? "today" : "in period") + "*");
        lines.add("Taxable value: " + inr(money.taxable()));
        lines.add("GST: " + inr(money.gst()));
        lines.add("Fees incl. GST: " + inr(money.fees()));
        lines.add("Security deposits received: " + inr(money.deposits()));
        lines.add("Refunds: " + inr(money.refunds()));
        lines.add("Security deposits returned: " + inr(money.depositsReturned()));
        if (money.waivedCount() > 0) lines.add("Charges waived (free bookings): " + inr(money.waived()) + " on " + money.waivedCount() + " booking" + (money.waivedCount() == 1 ? "" : "s"));
        lines.add("*Net received: " + inr(money.net()) + "*");
        lines.add("");
        lines.add("Awaiting payment: " + pending.size() + " (" + inr(total(pending, "totalPayable")) + ")");
        lines.add("Refunds due: " + refundDue.size() + " (" + inr(total(refundDue, "refundAmount")) + ")");
        lines.add("Deposits held: " + held.size() + " (" + inr(total(held, "depositAmount")) + ")");
        return new Report(head, String.join("\n", lines), money, new Counts(pending.size(), refundDue.size(), held.size()));
    }

    private static double total(List<JsonNode> l, String k) { double s = 0; for (JsonNode b : l) s += n0(Js.f(b, k)); return s; }
    private static char kindOf(JsonNode n) { return n == null || n.isMissingNode() ? 'u' : n.isNull() ? 'z' : n.isTextual() ? 's' : n.isNumber() ? 'n' : n.isBoolean() ? 'b' : 'o'; }
    /** `a >= b` / `a <= b` with a string on the right: only two strings compare as text (a number, undefined or null against a date string is never true). */
    private static boolean gte(JsonNode a, String b) { return a.isTextual() && a.asText().compareTo(b) >= 0; }
    private static boolean lte(JsonNode a, String b) { return a.isTextual() && a.asText().compareTo(b) <= 0; }
}
