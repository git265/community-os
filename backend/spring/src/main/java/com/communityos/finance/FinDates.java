package com.communityos.finance;

import com.communityos.amenities.AmenityEngine;
import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The date and money helpers of src/lib/finance/rules.js, with their JavaScript habits: a date is a local calendar day written "2026-10-20", a day
 * that does not exist in its month rolls into the next ("2026-02-30" is 2 March, as V8 reads it), an unreadable date gives "NaN-NaN-NaN" and
 * "Invalid Date", amounts print with lakh / crore grouping (this server, like the JavaScript one, has no other country profile loaded).
 */
public final class FinDates {
    private FinDates() {}

    private static final Pattern ISO = Pattern.compile("^(\\d{4})-(\\d{2})-(\\d{2})$");
    private static final String[] MONTHS = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"};   // en-GB, as ICU 7x writes September
    public static final double EPSILON = 2.220446049250313E-16;

    /** `new Date(`${iso}T00:00:00`)` as a local calendar day; null when that is an Invalid Date. */
    public static LocalDate parse(String iso) {
        if (iso == null) return null;
        Matcher m = ISO.matcher(iso);
        if (!m.matches()) return null;
        int y = Integer.parseInt(m.group(1)), mo = Integer.parseInt(m.group(2)), d = Integer.parseInt(m.group(3));
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        return LocalDate.of(y, mo, 1).plusDays(d - 1L);
    }

    public static String fmt(LocalDate d) {
        if (d == null) return "NaN-NaN-NaN";
        return String.format("%d-%02d-%02d", d.getYear(), d.getMonthValue(), d.getDayOfMonth());
    }

    /** todayIso(): the community's calendar day now. */
    public static String today(Clock clock, ZoneId zone) { return fmt(LocalDate.now(clock.withZone(zone))); }

    public static String addDays(String iso, double n) {
        LocalDate d = parse(iso);
        if (d == null || Double.isNaN(n) || Double.isInfinite(n)) return "NaN-NaN-NaN";
        return fmt(d.plusDays((long) n));
    }

    public static String addMonths(String iso, double n) {
        LocalDate d = parse(iso);
        if (d == null || Double.isNaN(n) || Double.isInfinite(n)) return "NaN-NaN-NaN";
        return fmt(d.plusMonths((long) n));
    }

    /** Math.round((b - a) / 86400000) in days; NaN when either is not a date. */
    public static double daysBetween(String a, String b) {
        LocalDate x = parse(a), y = parse(b);
        if (x == null || y == null) return Double.NaN;
        return ChronoUnit.DAYS.between(x, y);
    }

    /** dmy(): "05 Sept 2026"; '' when nothing is given; "Invalid Date" for a text that is not a day. */
    public static String dmy(JsonNode s) { return Js.truthy(s) ? dmy(Js.toStr(s)) : ""; }

    public static String dmy(String s) {
        if (s == null || s.isEmpty()) return "";
        LocalDate d = parse(s.length() > 10 ? s.substring(0, 10) : s);
        if (d == null) return "Invalid Date";
        return String.format("%02d %s %d", d.getDayOfMonth(), MONTHS[d.getMonthValue() - 1], d.getYear());
    }

    /** `Math.round((Number(n) + Number.EPSILON) * 100) / 100` (NaN stays NaN). */
    public static double r2(double n) { return AmenityEngine.jsRound((n + EPSILON) * 100) / 100; }

    /** inr(): `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}` */
    public static String inr(double n) { return "₹" + AmenityEngine.groupIndian(AmenityEngine.jsRound(Double.isNaN(n) || n == 0 ? 0.0 : n), 0); }   // `|| 0` turns -0 into 0
    public static String inr(JsonNode n) { return inr(Js.number(n)); }

    /** The community's month key, "2026-10". */
    public static String monthKey(Clock clock, ZoneId zone) { return today(clock, zone).substring(0, 7); }

    /**
     * `Number(n || 0).toLocaleString('en-IN')`: lakh / crore grouping and up to three decimals (the default of toLocaleString), no rounding to whole rupees.
     * NaN prints "NaN".
     */
    public static String localeIn(double v) {
        if (Double.isNaN(v)) return "NaN";
        if (Double.isInfinite(v)) return v > 0 ? "∞" : "-∞";
        boolean negative = v < 0 || (v == 0 && 1 / v < 0);
        java.math.BigDecimal bd = new java.math.BigDecimal(Double.toString(Math.abs(v))).setScale(3, java.math.RoundingMode.HALF_UP).stripTrailingZeros();
        if (bd.scale() < 0) bd = bd.setScale(0);
        String plain = bd.toPlainString();
        String whole = plain, frac = "";
        int dot = plain.indexOf('.');
        if (dot >= 0) { whole = plain.substring(0, dot); frac = plain.substring(dot); }
        StringBuilder sb = new StringBuilder();
        if (whole.length() <= 3) sb.append(whole);
        else {
            String head = whole.substring(0, whole.length() - 3), tail = whole.substring(whole.length() - 3);
            for (int i = 0; i < head.length(); i++) { if (i > 0 && (head.length() - i) % 2 == 0) sb.append(','); sb.append(head.charAt(i)); }
            sb.append(',').append(tail);
        }
        return (negative ? "-" : "") + sb + frac;
    }

    /** `₹${Number(n || 0).toLocaleString('en-IN')}` */
    public static String rupees(JsonNode n) { double d = Js.truthy(n) ? Js.toNumber(n) : 0; return "₹" + localeIn(d); }
}
