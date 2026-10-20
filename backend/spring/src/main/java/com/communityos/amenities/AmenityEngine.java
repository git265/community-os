package com.communityos.amenities;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.DoubleNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.LongNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Amenity pricing, GST, deposit, cancellation / refund rules and add-on items. A port of src/lib/amenityEngine.js (the pure functions the booking
 * screen previews and the server charges). The JavaScript habits that matter are kept on purpose: `Number(x) || 0`, Math.round (halves go up),
 * dates written "YYYY-MM-DDTHH:MM:SS" are LOCAL time, and a date that cannot be read is NaN, which makes every comparison false.
 * Held equal to the JavaScript by AmenityConformanceCheck.
 */
public final class AmenityEngine {
    private AmenityEngine() {}

    private static final JsonNodeFactory F = JsonNodeFactory.instance;
    public static final String DEFAULT_REFUND_MODE = "Original payment mode (manual)";

    // The payment modes of a community in India (the default of the Node server, which never loads a country profile).
    public static final List<String> ONLINE_MODES = List.of("UPI", "Card", "Net banking");
    public static final List<String> OFFICE_MODES = List.of("Cash", "Cheque");
    public static final List<String> ALL_MODES = List.of("UPI", "Card", "Net banking", "Cheque", "Cash", "Bank transfer");
    public static final List<String> REF_MODES = List.of("UPI", "Net banking", "Bank transfer", "Cheque");
    public static String defaultOnlineMode() { return ONLINE_MODES.get(0); }
    public static boolean needsRef(String mode) { return mode != null && REF_MODES.contains(mode); }

    // ---- numbers -------------------------------------------------------------------------------------------------------

    /** Math.round for a double (halves go up; -0 for a small negative). */
    public static double jsRound(double x) {
        if (Double.isNaN(x) || Double.isInfinite(x)) return x;
        double r = Math.floor(x + 0.5);
        return r == 0 && (x < 0 || (x == 0 && 1 / x < 0)) ? -0.0 : r;
    }

    /** `Math.round((Number(n) || 0) * 100) / 100` */
    public static double round2(double n) { return jsRound((Double.isNaN(n) ? 0 : n) * 100) / 100; }
    public static double round2(JsonNode n) { return round2(Js.number(n)); }
    public static double round2(JsonNode rec, String key) { return round2(Js.number(rec, key)); }

    /** A computed number as JSON, the way JSON.stringify would write it (whole numbers without ".0", NaN as null). */
    public static JsonNode num(double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) return NullNode.getInstance();
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return LongNode.valueOf((long) d);
        return DoubleNode.valueOf(d);
    }

    /** `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: round2(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}` */
    public static String inr(double n) {
        double r = round2(n);
        double rem = r % 1;
        boolean frac = !Double.isNaN(rem) && rem != 0;
        return "₹" + groupIndian(r, frac ? 2 : 0);
    }
    public static String inr(JsonNode n) { return inr(Js.number(n)); }

    /** 1234567.5 -> "12,34,567.50": lakh / crore grouping. */
    public static String groupIndian(double v, int fraction) {
        if (Double.isNaN(v)) return "NaN";
        if (Double.isInfinite(v)) return v > 0 ? "∞" : "-∞";
        boolean negative = v < 0 || (v == 0 && 1 / v < 0);
        BigDecimal bd = new BigDecimal(Double.toString(Math.abs(v))).setScale(fraction, RoundingMode.HALF_EVEN);
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

    public static double creditBalance(List<JsonNode> rows, JsonNode unit) {
        double sum = 0;
        for (JsonNode r : rows) if (Js.strictEq(Js.f(r, "unit"), unit)) sum += (Js.is(r, "type", "Credit") ? 1 : -1) * Js.number(r, "amount");
        return round2(sum);
    }

    // ---- dates (local time, as `new Date("2026-10-20T10:00:00")` reads it) -----------------------------------------------------

    private static final Pattern LOCAL = Pattern.compile("^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})$");

    /** Epoch milliseconds of a local "YYYY-MM-DDTHH:MM:SS", or NaN when JavaScript would give Invalid Date. Day 29-31 of a short month rolls over, as in V8. */
    public static double parseLocal(String s, ZoneId zone) {
        if (s == null) return Double.NaN;
        Matcher m = LOCAL.matcher(s);
        if (!m.matches()) return Double.NaN;
        int y = Integer.parseInt(m.group(1)), mo = Integer.parseInt(m.group(2)), d = Integer.parseInt(m.group(3));
        int h = Integer.parseInt(m.group(4)), mi = Integer.parseInt(m.group(5)), se = Integer.parseInt(m.group(6));
        if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || se > 59 || (h == 24 && (mi != 0 || se != 0))) return Double.NaN;
        LocalDateTime t = LocalDate.of(y, mo, 1).plusDays(d - 1L).atStartOfDay().plusHours(h).plusMinutes(mi).plusSeconds(se);
        return t.atZone(zone).toInstant().toEpochMilli();
    }

    /** `new Date(`${date}T12:00:00`).getDay()` is a Saturday or a Sunday (false for an unreadable date). */
    static boolean isWeekend(JsonNode date, ZoneId zone) {
        double ms = parseLocal(Js.toStr(date) + "T12:00:00", zone);
        if (Double.isNaN(ms)) return false;
        java.time.DayOfWeek dow = java.time.Instant.ofEpochMilli((long) ms).atZone(zone).getDayOfWeek();
        return dow == java.time.DayOfWeek.SATURDAY || dow == java.time.DayOfWeek.SUNDAY;
    }

    private static final Pattern HOURS = Pattern.compile("^(\\d{1,2}):(\\d{2})");

    /** When the booking starts (local time): a slot starts at its first hour, a full-day booking at the amenity's opening time. */
    public static String startAtOf(JsonNode date, JsonNode slot, JsonNode amenity) {
        String subject = Js.truthy(slot) && !(slot.isTextual() && "Full day".equals(slot.asText())) ? Js.toStr(slot) : Js.orEmpty(Js.f(amenity, "hours"));
        Matcher m = HOURS.matcher(subject);
        String hh = "00", mm = "00";
        if (m.find()) { hh = m.group(1).length() < 2 ? "0" + m.group(1) : m.group(1); mm = m.group(2); }
        return Js.toStr(date) + "T" + hh + ":" + mm + ":00";
    }

    /** `(new Date(startAt).getTime() - now) / 3600000` */
    public static double hoursUntil(String startAt, long nowMillis, ZoneId zone) { return (parseLocal(startAt, zone) - nowMillis) / 3600000.0; }

    // ---- cancellation tiers -----------------------------------------------------------------------------------------------------

    /** The default cancellation policy: 72 h before 100%, 24 h before 50%, otherwise nothing. */
    private static List<JsonNode> defaultTiers() {
        List<JsonNode> l = new ArrayList<>();
        l.add(tier(72, 100)); l.add(tier(24, 50)); l.add(tier(0, 0));
        return l;
    }
    private static ObjectNode tier(double hoursBefore, double refundPct) { ObjectNode o = F.objectNode(); o.set("hoursBefore", num(hoursBefore)); o.set("refundPct", num(refundPct)); return o; }

    /** Cancellation tiers, cleaned and sorted (longest notice first). Falls back to the community default. */
    public static List<JsonNode> tiersOf(JsonNode amenity) {
        JsonNode raw = Js.f(amenity, "cancellationRules");
        List<JsonNode> in = raw.isArray() && raw.size() > 0 ? Js.list(amenity, "cancellationRules") : defaultTiers();
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode t : in) out.add(tier(Math.max(0, Js.number(t, "hoursBefore")), Math.min(100, Math.max(0, Js.number(t, "refundPct")))));
        out.sort((a, b) -> Double.compare(b.get("hoursBefore").asDouble(), a.get("hoursBefore").asDouble()));
        return out;
    }

    public static ArrayNode tiersJson(JsonNode amenity) { ArrayNode a = F.arrayNode(); a.addAll(tiersOf(amenity)); return a; }

    // ---- the price -----------------------------------------------------------------------------------------------------------------

    public record Quote(boolean free, boolean weekend, double addOn, double rate, String rateUnit, double base, double gstRate, double gst, double fee, String gstMode, double deposit, double total, double halves) {
        /** The same quote with nothing to pay (a charge waived by the amenities team). */
        Quote waived() { return new Quote(true, weekend, addOn, 0, rateUnit, 0, 0, 0, 0, gstMode, 0, 0, 0); }
    }

    /** The amount on the booking screen: rate -> taxable value -> GST -> fee, plus the refundable security deposit. */
    public static Quote quote(JsonNode amenity, JsonNode date, JsonNode settings, double extras, ZoneId zone) {
        double addOn = round2(Double.isNaN(extras) ? 0 : extras);
        double rateNum = Js.toNumber(Js.f(amenity, "rate"));
        boolean rateUnitFree = Js.is(amenity, "rateUnit", "Free");
        boolean serviceFree = rateUnitFree || !(rateNum > 0);
        boolean free = serviceFree && addOn <= 0;
        boolean weekend = Js.truthy(date) && isWeekend(date, zone) && Js.toNumber(Js.f(amenity, "weekendRate")) > 0;
        double rate;
        if (free) rate = 0;
        else {
            double unitRate = 0;
            if (!serviceFree) {
                JsonNode pick = weekend ? (Js.truthy(amenity, "weekendRate") ? Js.f(amenity, "weekendRate") : Js.f(amenity, "rate")) : Js.f(amenity, "rate");
                unitRate = Js.toNumber(pick);
            }
            rate = unitRate + addOn;
        }
        boolean gstOn = !free && Js.truthy(amenity, "gstApplicable");
        double gstRate = 0;
        if (gstOn) {
            JsonNode g = Js.f(amenity, "gstRate");
            if (g.isMissingNode() || g.isNull()) g = Js.f(settings, "defaultGstRate");
            gstRate = g.isMissingNode() || g.isNull() ? 18 : Js.toNumber(g);
        }
        String mode = Js.truthy(amenity, "gstMode") ? Js.toStr(Js.f(amenity, "gstMode")) : "Exclusive";
        double base = rate, gst = 0, fee = rate;
        if (gstOn && "Inclusive".equals(mode)) { base = round2(rate / (1 + gstRate / 100)); gst = round2(rate - base); fee = round2(rate); }
        if (gstOn && !"Inclusive".equals(mode)) { base = round2(rate); gst = round2(base * gstRate / 100); fee = round2(base + gst); }
        double deposit = round2(Js.number(amenity, "depositAmount"));
        String rateUnit = Js.truthy(amenity, "rateUnit") ? Js.toStr(Js.f(amenity, "rateUnit")) : "Per day / event";
        return new Quote(free, weekend, addOn, rate, rateUnit, base, gstRate, gst, fee, mode, deposit, round2(fee + deposit), gstOn ? round2(gst / 2) : 0);
    }

    // ---- booking window and limits ---------------------------------------------------------------------------------------------------

    /** Can this booking still be made? (minimum notice and how far ahead residents may book) */
    public static String bookingWindowError(JsonNode amenity, JsonNode date, JsonNode slot, long nowMillis, ZoneId zone) {
        double left = hoursUntil(startAtOf(date, slot, amenity), nowMillis, zone);
        double minH = Js.number(amenity, "minNoticeHours"), maxD = Js.number(amenity, "maxAdvanceDays");
        if (left < 0) return "That time has already passed.";
        if (minH != 0 && left < minH) return "This amenity must be booked at least " + Js.numberToString(minH) + " hour" + (minH == 1 ? "" : "s") + " ahead.";
        if (maxD != 0 && left > maxD * 24) return "This amenity can be booked at most " + Js.numberToString(maxD) + " days ahead.";
        return "";
    }

    /** Is it the amenity's team who may ignore the booking window and limits? (Super Admin always; otherwise the roles the committee named.) */
    public static boolean canOverrideRules(JsonNode amenity, String roleId, boolean isStaff) {
        if (!isStaff) return false;
        if ("super_admin".equals(roleId)) return true;
        JsonNode roles = Js.f(amenity, "overrideRoles");
        if (!Js.truthy(roles)) return true;                       // `!(x || []).length`
        if (roles.isArray()) { if (roles.size() == 0) return true; for (JsonNode r : roles) if (r.isTextual() && r.asText().equals(roleId)) return true; return false; }
        if (roles.isTextual()) return roleId != null && roles.asText().contains(roleId);   // a text has a length: String.includes
        return true;                                             // a number or object has no length: `!undefined`
    }

    private static boolean includes(JsonNode list, JsonNode value) {
        if (!list.isArray()) return false;
        for (JsonNode x : list) if (Js.strictEq(x, value)) return true;
        return false;
    }

    /** `a >= b` for a field and a text: only text compares (number or undefined >= text is false). */
    static boolean textGe(JsonNode a, String b) { return a.isTextual() && a.asText().compareTo(b) >= 0; }

    /** The per-amenity limits a resident is held to: blocked dates, which unit types may book, and how many bookings a unit may hold. */
    public static String bookingRulesError(JsonNode amenity, JsonNode date, JsonNode unit, JsonNode unitType, List<JsonNode> bookings, String utcToday) {
        JsonNode a = amenity == null ? Js.MISSING : amenity;
        if (unit.isMissingNode()) unit = F.textNode("");           // the defaults of the JavaScript parameters
        if (unitType.isMissingNode()) unitType = F.textNode("");
        final JsonNode unitF = unit;
        String name = Js.toStr(Js.f(a, "name"));
        if (includes(blackout(a), date)) return name + " is closed on " + Js.toStr(date) + ".";
        List<JsonNode> types = Js.list(a, "allowedUnitTypes");
        if (!types.isEmpty() && Js.truthy(unitType) && !includes(Js.f(a, "allowedUnitTypes"), unitType)) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < types.size(); i++) { if (i > 0) sb.append(" / "); JsonNode t = types.get(i); if (!t.isNull() && !t.isMissingNode()) sb.append(Js.toStr(t)); }
            return name + " can be booked by " + sb.toString().toLowerCase(Locale.ROOT) + " units only.";
        }
        List<JsonNode> mine = new ArrayList<>();
        for (JsonNode b : bookings) if (Js.strictEq(Js.f(b, "unit"), unitF) && Js.strictEq(Js.f(b, "amenity"), Js.f(a, "name")) && !Js.is(b, "status", "Cancelled")) mine.add(b);
        double perDay = Js.number(a, "maxPerDay");
        if (perDay != 0) { long n = mine.stream().filter(b -> Js.strictEq(Js.f(b, "date"), date)).count(); if (n >= perDay) return "One unit can hold at most " + Js.numberToString(perDay) + " booking" + (perDay == 1 ? "" : "s") + " a day for " + name + "."; }
        double perMonth = Js.number(a, "maxPerMonth");
        if (perMonth != 0) {
            String month = slice7(date);
            long n = mine.stream().filter(b -> slice7(Js.f(b, "date")).equals(month)).count();
            if (n >= perMonth) return "One unit can book " + name + " at most " + Js.numberToString(perMonth) + " time" + (perMonth == 1 ? "" : "s") + " a month.";
        }
        double upcoming = Js.number(a, "maxUpcoming");
        if (upcoming != 0) {
            long n = mine.stream().filter(b -> textGe(Js.f(b, "date"), utcToday) && !Js.is(b, "status", "Completed")).count();
            if (n >= upcoming) return "You already hold " + Js.numberToString(upcoming) + " upcoming booking" + (upcoming == 1 ? "" : "s") + " for " + name + ". Use or cancel one first.";
        }
        return "";
    }
    private static JsonNode blackout(JsonNode a) { JsonNode b = Js.f(a, "blackoutDates"); return b.isArray() ? b : Js.MISSING; }
    /** `String(x).slice(0, 7)` */
    private static String slice7(JsonNode x) { String s = Js.toStr(x); return s.length() > 7 ? s.substring(0, 7) : s; }

    // ---- what cancelling now refunds ---------------------------------------------------------------------------------------------------

    /** @param pct the refund percentage as stored on the tier (kept as written, it is copied onto the booking) */
    public record CancelQuote(JsonNode pct, double feePaid, double depPaid, double refundFee, double refundDeposit) {}

    /**
     * What cancelling NOW refunds. The fee is refunded by the tier of notice; the security deposit is always returned in full. A staff-waived
     * cancellation (e.g. the community cancels) refunds everything.
     */
    public static CancelQuote cancellationQuote(JsonNode booking, JsonNode amenity, long nowMillis, ZoneId zone, boolean waive) {
        JsonNode started = Js.f(booking, "startAt");
        String startAt = Js.truthy(started) ? Js.toStr(started) : startAtOf(Js.f(booking, "date"), Js.f(booking, "slot"), amenity);
        double left = hoursUntil(startAt, nowMillis, zone);
        JsonNode snap = Js.f(booking, "policySnapshot");
        List<JsonNode> tiers = snap.isArray() && snap.size() > 0 ? Js.list(booking, "policySnapshot") : tiersOf(amenity);
        JsonNode tier = null;
        for (JsonNode t : tiers) if (left >= Js.toNumber(Js.f(t, "hoursBefore"))) { tier = t; break; }
        JsonNode pct = waive ? num(100) : tier != null ? Js.f(tier, "refundPct") : num(0);
        boolean paid = Js.is(booking, "paymentStatus", "Paid");
        double feePaid = paid ? round2(booking, "feeTotal") : 0;
        double depPaid = paid ? round2(booking, "depositAmount") : 0;
        double refundFee = round2(feePaid * Js.toNumber(pct) / 100);
        return new CancelQuote(pct, feePaid, depPaid, refundFee, depPaid);
    }

    // ---- add-on items (chairs, tables ...) with a quantity ---------------------------------------------------------------------------

    private static final ObjectMapper STRICT = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    /** JSON.parse: the value, or null when it is not valid JSON. */
    public static JsonNode jsonParse(String s) {
        try { JsonNode n = STRICT.readTree(s); return n == null || n.isMissingNode() ? null : n; } catch (Exception e) { return null; }
    }

    /** `parseExtras`: the booked add-on lines (itemId and a quantity above zero). */
    static List<JsonNode> parseExtras(JsonNode v) {
        JsonNode a = v;
        if (v.isTextual()) { a = jsonParse(Js.truthy(v) ? v.asText() : "[]"); if (a == null) return List.of(); }
        List<JsonNode> out = new ArrayList<>();
        if (!a.isArray()) return out;
        for (JsonNode x : a) if (Js.truthy(x) && Js.truthy(x, "itemId") && Js.toNumber(Js.f(x, "qty")) > 0) out.add(x);
        return out;
    }

    /** Items offered with an amenity: those for every amenity plus those set for this one. */
    static List<JsonNode> itemsFor(List<JsonNode> items, JsonNode amenityName) {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode i : items) if (!Js.strictEq(Js.f(i, "active"), F.booleanNode(false)) && (!Js.truthy(i, "amenity") || Js.strictEq(Js.f(i, "amenity"), amenityName))) out.add(i);
        return out;
    }

    private static boolean overlaps(JsonNode b, JsonNode date, JsonNode slot) {
        return Js.strictEq(Js.f(b, "date"), date) && !Js.is(b, "status", "Cancelled")
                && (Js.strictEq(slot, F.textNode("Full day")) || Js.is(b, "slot", "Full day") || Js.strictEq(Js.f(b, "slot"), slot));
    }

    /** How many of an item are still free on a date and slot (stock less what other bookings already hold). */
    static double itemLeft(JsonNode item, List<JsonNode> bookings, JsonNode date, JsonNode slot) {
        double held = 0;
        for (JsonNode b : bookings) {
            if (Js.strictEq(Js.f(b, "id"), F.textNode("")) || !overlaps(b, date, slot)) continue;   // `b.id !== ignoreId` with ignoreId = ''

            for (JsonNode x : parseExtras(Js.f(b, "extras"))) if (Js.strictEq(Js.f(x, "itemId"), Js.f(item, "id"))) held += Js.toNumber(Js.f(x, "qty"));
        }
        return Math.max(0, Js.number(item, "stock") - held);
    }

    public record Extras(String error, ArrayNode lines, double total) {}

    /** Turn { itemId: qty } into booked lines priced from the catalog, or an error. Never trusts the browser's prices. */
    public static Extras priceExtras(JsonNode picks, List<JsonNode> items, List<JsonNode> bookings, JsonNode amenityName, JsonNode date, JsonNode slot) {
        ArrayNode lines = F.arrayNode();
        double total = 0;
        JsonNode source = Js.truthy(picks) ? picks : F.objectNode();
        for (Map.Entry<String, JsonNode> e : Js.entries(source)) {
            double qty = Math.floor(Js.number(e.getValue()));
            if (qty <= 0) continue;
            JsonNode it = null;
            for (JsonNode i : itemsFor(items, amenityName)) if (Js.strictEq(Js.f(i, "id"), F.textNode(e.getKey()))) { it = i; break; }
            if (it == null) return new Extras("One of the add-on items is not available for this amenity", null, 0);
            double cap = Js.toNumber(Js.f(it, "maxPerBooking")) > 0 ? Js.toNumber(Js.f(it, "maxPerBooking")) : Double.POSITIVE_INFINITY;
            String itemName = Js.toStr(Js.f(it, "name")).toLowerCase(Locale.ROOT);
            if (qty > cap) return new Extras("At most " + Js.numberToString(cap) + " " + itemName + " per booking", null, 0);
            double left = itemLeft(it, bookings, date, slot);
            if (qty > left) return new Extras("Only " + Js.numberToString(left) + " " + itemName + " left for that time", null, 0);
            double line = round2(qty * Js.number(it, "price")); total += line;
            ObjectNode o = F.objectNode();
            o.put("itemId", e.getKey()); if (!Js.f(it, "name").isMissingNode()) o.set("name", Js.f(it, "name")); o.set("qty", num(qty)); o.set("price", num(Js.number(it, "price"))); o.set("amount", num(line));
            lines.add(o);
        }
        return new Extras(null, lines, round2(total));
    }
}
