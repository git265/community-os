package com.communityos.finance;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;

/**
 * The words that explain a charge: the tax breakdown, the due date and how a late fee applies. A port of taxBreakdown / dueInfo / penaltyRule /
 * penaltyExample / billTermsLines in src/lib/billText.js and of termsFor in billTermsServer.js, for a community in India (CGST + SGST, rupees with
 * lakh / crore grouping) like every other message of this server.
 */
public final class BillTerms {
    private BillTerms() {}

    public record Line(String label, double rate, double amount) {}
    public record Tax(String name, double rate, String mode, double taxable, double tax, double total, List<Line> lines) {}
    public record DueInfo(String tone, String text, double days) {}
    public record Example(boolean accrued, double per, int months, double total, String from) {}

    private static final String[] SPLIT_LABEL = {"CGST", "SGST"};
    private static final double[] SPLIT_SHARE = {0.5, 0.5};

    /** locale.js money(): `₹` + fmtNum(Math.round(Number(n) || 0)), and fmtNum does `Number(x) || 0` again, so -0 prints as 0 (unlike rules.js inr). */
    static String money(double n) {
        double r = com.communityos.amenities.AmenityEngine.jsRound(Double.isNaN(n) ? 0 : n);
        return "₹" + com.communityos.amenities.AmenityEngine.groupIndian(r == 0 ? 0.0 : r, 0);
    }

    /** `{ amount, rate, mode, flatTax }`: a rate with Inclusive (tax inside the price) or Exclusive (added on top), or a flat tax inside the total. */
    public static Tax taxBreakdown(JsonNode amount, JsonNode rate, JsonNode mode, JsonNode flatTax) {
        double a = Js.number(amount), r = Js.number(rate);
        double taxable = a, tax = 0, total = a;
        boolean inclusive = Js.strictEq(mode, com.fasterxml.jackson.databind.node.TextNode.valueOf("Inclusive"));
        if (r > 0) {
            if (inclusive) { taxable = FinDates.r2(a / (1 + r / 100)); tax = FinDates.r2(a - taxable); total = a; }
            else { taxable = a; tax = FinDates.r2((a * r) / 100); total = FinDates.r2(a + tax); }
        } else if (Js.number(flatTax) > 0) { tax = FinDates.r2(Js.number(flatTax)); taxable = FinDates.r2(a - tax); total = a; }
        List<Line> lines = new ArrayList<>();
        if (tax > 0) {
            double earlier = 0;
            for (int i = 0; i < SPLIT_LABEL.length; i++) {
                boolean last = i == SPLIT_LABEL.length - 1;
                double amt;
                if (last) { for (int j = 0; j < i; j++) earlier = earlier + FinDates.r2(tax * SPLIT_SHARE[j]); amt = FinDates.r2(tax - earlier); }
                else amt = FinDates.r2(tax * SPLIT_SHARE[i]);
                lines.add(new Line(SPLIT_LABEL[i], r > 0 ? FinDates.r2(r * SPLIT_SHARE[i]) : 0, amt));
            }
        }
        return new Tax("GST", r, inclusive ? "Inclusive" : "Exclusive", taxable, tax, total, lines);
    }

    /** "Pay by 15 Oct 2026 · 3 days left" / "Overdue by 4 days (was due ...)", with a tone the screen can colour. */
    public static DueInfo dueInfo(JsonNode dueDate, JsonNode status, String today) {
        if (Js.strictEq(status, com.fasterxml.jackson.databind.node.TextNode.valueOf("Paid"))) return new DueInfo("paid", "Paid", 0);
        if (!Js.truthy(dueDate)) return new DueInfo("ok", "No due date", 0);
        String s = Js.toStr(dueDate);
        double left = FinDates.daysBetween(today, s.length() > 10 ? s.substring(0, 10) : s);
        String when = FinDates.dmy(dueDate);
        if (left < 0) return new DueInfo("over", "Overdue by " + Js.numberToString(-left) + " day" + (left == -1 ? "" : "s") + " (was due " + when + ")", left);
        if (left == 0) return new DueInfo("soon", "Due today (" + when + ")", 0);
        return new DueInfo(left <= 3 ? "soon" : "ok", "Pay by " + when + " · " + Js.numberToString(left) + " day" + (left == 1 ? "" : "s") + " left", left);
    }

    /** The community's late-fee rule in one sentence. */
    public static String penaltyRule(LateFees.Settings settings, JsonNode category) {
        LateFees.Rule s = settings != null && settings.enabled() ? LateFees.ruleFor(settings, category) : null;
        if (s == null) return "No late fee is charged on this bill.";
        String amt = s.kind().equals("Fixed per month") ? "a fixed " + money(s.value()) : Js.numberToString(s.value()) + "% of the bill";
        return "If not paid by the due date" + (s.grace() != 0 ? " plus " + Js.numberToString(s.grace()) + " day" + (s.grace() == 1 ? "" : "s") + " grace" : "")
                + ", a late fee of " + amt + " is added for every month it stays unpaid"
                + (s.maxMonths() != 0 ? ", up to " + Js.numberToString(s.maxMonths()) + " month" + (s.maxMonths() == 1 ? "" : "s") : "") + ". Late fees do not earn late fees.";
    }

    /** What the penalty would be (first charge date and amount), or what has already built up; null when no late fee applies to this bill. */
    public static Example penaltyExample(JsonNode due, LateFees.Settings settings, String today) {
        LateFees.Rule s = settings != null && settings.enabled() ? LateFees.ruleFor(settings, Js.f(due, "category")) : null;
        if (s == null || !Js.truthy(due, "dueDate") || Js.is(due, "status", "Paid") || Js.is(due, "category", "Late fee")) return null;
        double base = Js.number(due, "grossAmount") != 0 ? Js.number(due, "grossAmount") : Js.number(due, "amount");
        double per = s.kind().equals("Fixed per month") ? FinDates.r2(s.value()) : FinDates.r2((base * s.value()) / 100);
        String start = FinDates.addDays(Js.toStr(Js.f(due, "dueDate")), s.grace());
        int months = 0;
        double cap = s.maxMonths() != 0 ? s.maxMonths() : 36;
        for (int k = 1; k <= cap; k++) { if (today.compareTo(FinDates.addMonths(start, k - 1)) > 0) months = k; else break; }
        return months > 0 ? new Example(true, per, months, FinDates.r2(per * months), start) : new Example(false, per, 0, 0, start);
    }

    /** Plain-text lines for a bill (what termsFor appends to a message): the tax breakdown, the due date, how a late fee applies. */
    public static List<String> lines(JsonNode due, LateFees.Settings settings, String today, boolean showPenalty) {
        Tax tb = taxBreakdown(Js.f(due, "amount"), Js.f(due, "gstRate"), Js.f(due, "gstMode"), Js.f(due, "tax"));
        List<String> out = new ArrayList<>();
        if (tb.tax() > 0) {
            StringBuilder b = new StringBuilder(tb.name()).append(" breakdown: taxable ").append(money(tb.taxable()));
            for (Line l : tb.lines()) b.append(" + ").append(l.label()).append(l.rate() != 0 ? " " + Js.numberToString(l.rate()) + "%" : "").append(' ').append(money(l.amount()));
            b.append(" = ").append(money(tb.total())).append(tb.mode().equals("Inclusive") && tb.rate() != 0 ? " (tax included in the price)" : "");
            out.add(b.toString());
        }
        DueInfo di = dueInfo(Js.f(due, "dueDate"), Js.f(due, "status"), today);
        if (Js.truthy(due, "dueDate")) out.add((di.tone().equals("over") ? "⚠ " : "") + di.text());
        if (showPenalty && settings != null) {
            out.add(penaltyRule(settings, Js.f(due, "category")));
            Example ex = penaltyExample(due, settings, today);
            if (ex != null) out.add(ex.accrued() ? "Late fee so far: " + ex.months() + " month(s) × " + money(ex.per()) + " = " + money(ex.total()) + "."
                    : "Example: if unpaid after " + FinDates.dmy(ex.from()) + ", " + money(ex.per()) + " is added each month.");
        }
        return out;
    }

    /** termsFor(): "\n\n" + the lines, or nothing when there are none. */
    public static String termsFor(JsonNode due, LateFees.Settings settings, String today) {
        String body = String.join("\n", lines(due, settings, today, true));
        return body.isEmpty() ? "" : "\n\n" + body;
    }
}
