package com.communityos.amenities;

import static com.communityos.amenities.AmenityEngine.ONLINE_MODES;
import static com.communityos.amenities.AmenityEngine.OFFICE_MODES;
import static com.communityos.amenities.AmenityEngine.round2;

import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.BooleanNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * What the server decides about an amenity booking BEFORE it is stored: the price is re-worked from the catalog (the amounts the browser sent
 * are ignored), availability and the booking window are checked, the payment state is decided, and the "actions" (cancel, receive payment, pay
 * refund, settle deposit) are turned into the right fields. A port of amenityPreWrite in src/lib/amenityServer.js; held equal to it by
 * AmenityConformanceCheck. It reads nothing itself: the caller passes the lists, the clock and the two lookups (an online payment, a
 * defaulter hold).
 */
public final class AmenityRules {
    private AmenityRules() {}

    private static final JsonNodeFactory F = JsonNodeFactory.instance;
    private static final List<String> STAFF_ONLY = List.of("adjust_fee", "receive_payment", "mark_refund_paid", "refund_to_credit", "settle_deposit", "mark_deposit_paid", "complete");
    private static final List<String> PAYOUT_ANY = concat(AmenityEngine.ALL_MODES, "Card");
    private static final List<String> PAYOUT_WITH_CREDIT = concat(PAYOUT_ANY, null);
    private static final List<String> TRANSIENT = List.of("_action", "newFee", "adjustReason", "freeOfCharge", "waiveReason", "waive", "refundOverride", "depositDeduction", "deductionReason", "paymentRef", "useCredit", "refundTo", "payoutMode", "initiate");
    private static final List<String> NOT_MOVED = List.of("id", "shortId", "recVersion", "recordCreatedAt", "recordCreatedBy", "lastUpdatedAt", "lastUpdatedBy", "notes");
    private static final Pattern TAGS = Pattern.compile("<[^>]*>");
    private static final Pattern NBSP = Pattern.compile("&nbsp;");
    private static final Pattern SPACES = Pattern.compile("[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+");

    private static List<String> concat(List<String> a, String extra) {
        List<String> l = new ArrayList<>(a);
        if (extra != null) l.add(extra); else l.add(0, "Unit credit");
        return l;
    }

    /** The lists a decision needs (read raw, below the permission layer). */
    public record Ctx(List<JsonNode> catalog, JsonNode settings, List<JsonNode> bookings, List<JsonNode> credits, List<JsonNode> properties, List<JsonNode> items) {}

    /** Checks that an online booking points at a real, unused, big-enough payment: "" when it is now this booking's, else the reason. */
    public interface PaymentVerifier { String verify(String ref, String unit, double amount, String bookingId); }
    /** The reason a unit may not book because of overdue dues, or "". */
    public interface DefaulterCheck { String block(JsonNode unit); }

    /** @param record the booking to store (null on an error) @param error the message to refuse with (null when fine) @param action create | cancel | ... | "" */
    public record Result(JsonNode record, String error, String action) {
        static Result error(String message) { return new Result(null, message, null); }
        static Result of(JsonNode record, String action) { return new Result(record, null, action); }
    }

    private static boolean isStaffActor(Principal p) {
        return p != null && ("super_admin".equals(p.roleId()) || "EC".equals(p.category()) || p.has("MANAGE_AMENITIES"));
    }

    // ---- small helpers on JSON values --------------------------------------------------------------------------------------------

    private static JsonNode txt(String s) { return F.textNode(s); }
    private static JsonNode f(JsonNode r, String k) { return Js.f(r, k); }
    private static boolean t(JsonNode r, String k) { return Js.truthy(r, k); }
    private static boolean is(JsonNode r, String k, String v) { return Js.is(r, k, v); }
    /** `x || fallback` */
    private static JsonNode or(JsonNode x, JsonNode fallback) { return Js.truthy(x) ? x : fallback; }
    /** `{ ...a, ...b }` */
    private static ObjectNode spread(JsonNode... parts) {
        ObjectNode out = F.objectNode();
        for (JsonNode p : parts) if (p != null && p.isObject()) out.setAll((ObjectNode) p.deepCopy());
        return out;
    }
    /** `obj.key = value`; undefined drops the key, as JSON does. */
    private static void put(ObjectNode o, String k, JsonNode v) { if (v == null || v.isMissingNode()) o.remove(k); else o.set(k, v); }
    private static void put(ObjectNode o, String k, String v) { o.put(k, v); }
    private static void put(ObjectNode o, String k, double v) { o.set(k, AmenityEngine.num(v)); }
    private static void put(ObjectNode o, String k, boolean v) { o.put(k, v); }
    private static JsonNode find(List<JsonNode> rows, java.util.function.Predicate<JsonNode> p) { for (JsonNode r : rows) if (p.test(r)) return r; return null; }
    private static String name(Principal p) { return p != null && p.name() != null && !p.name().isEmpty() ? p.name() : ""; }
    private static String lower(String s) { return s.toLowerCase(Locale.ROOT); }
    private static String needRef(String pm) { return "Enter the " + ("Cheque".equals(pm) ? "cheque number" : "transaction / UTR reference"); }
    private static String cannotAuto(JsonNode pm) { return "A " + (Js.truthy(pm) ? Js.toStr(pm) : "cash") + " payment cannot be sent back automatically - pay it out and record it instead"; }
    private static boolean in(List<String> modes, JsonNode m) { return m.isTextual() && modes.contains(m.asText()); }

    /** `String(x || '').trim()` */
    private static String trimmed(JsonNode x) { return Js.trim(Js.orEmpty(x)); }

    /** `GW` + the time in base 36 + three random characters. */
    public static String gatewayRef(Clock clock) {
        String rnd = Long.toString(java.util.concurrent.ThreadLocalRandom.current().nextLong(36L * 36 * 36 * 4), 36);
        rnd = (rnd + "000").substring(0, 3);
        return "GW" + Long.toString(clock.millis(), 36).toUpperCase(Locale.ROOT) + rnd.toUpperCase(Locale.ROOT);
    }

    // ---- the decision --------------------------------------------------------------------------------------------------------------

    /**
     * @param bookingId the id the booking is stored under (an online payment is claimed for it)
     * @param verifier  null when there is no payment service (the browser demo trusts the simulator)
     */
    public static Result preWrite(Ctx ctx, JsonNode record, JsonNode old, boolean isNew, Principal p, Clock clock, ZoneId zone, PaymentVerifier verifier,
                                  String bookingId, DefaulterCheck defaulter, Supplier<String> gatewayRef) {
        boolean staff = isStaffActor(p);
        String nowIso = com.communityos.service.audit.Stamps.iso(clock);
        long nowMs = clock.millis();
        String today = nowIso.substring(0, 10);                        // `new Date().toISOString().slice(0, 10)`: the UTC date
        ObjectNode clean = record.deepCopy();
        JsonNode action = f(clean, "_action");
        double newFeeNumber;
        JsonNode newFee = f(clean, "newFee");
        String adjustReason = trimmed(f(clean, "adjustReason"));
        boolean freeOfCharge = t(clean, "freeOfCharge");
        String waiveReason = trimmed(f(clean, "waiveReason"));
        boolean waive = t(clean, "waive");
        JsonNode refundOverride = f(clean, "refundOverride");
        double depositDeduction = Js.number(clean, "depositDeduction");
        JsonNode deductionReason = or(f(clean, "deductionReason"), txt(""));
        JsonNode paymentRef = or(f(clean, "paymentRef"), txt(""));
        boolean useCredit = t(clean, "useCredit");
        JsonNode refundTo = or(f(clean, "refundTo"), txt(""));
        JsonNode payoutMode = or(f(clean, "payoutMode"), txt(""));
        boolean initiate = t(clean, "initiate");
        for (String k : TRANSIENT) clean.remove(k);
        JsonNode settings = ctx.settings();

        if (isNew) return newBooking(ctx, clean, record, staff, p, clock, zone, nowMs, today, freeOfCharge, waiveReason, useCredit, paymentRef, verifier, bookingId, defaulter);

        // ---- an existing booking: only through an action ----
        JsonNode amenity = find(ctx.catalog(), a -> Js.strictEq(f(a, "name"), f(old, "amenity")));
        if (amenity == null) amenity = F.objectNode();
        if (!Js.truthy(action)) {
            List<String> moved = new ArrayList<>();
            var it = clean.fieldNames();
            while (it.hasNext()) { String k = it.next(); if (!NOT_MOVED.contains(k) && Js.differs(f(clean, k), f(old, k))) moved.add(k); }
            if (!moved.isEmpty()) return Result.error("Use the booking actions (cancel, receive payment, refund, deposit) - " + String.join(", ", moved) + " cannot be edited directly");
            return Result.of(clean, "");
        }
        String act = action.isTextual() ? action.asText() : null;
        if (act != null && STAFF_ONLY.contains(act) && !staff) return Result.error("Requires amenities management access");
        String me = name(p);

        if ("adjust_fee".equals(act)) {
            if (!(is(old, "status", "Confirmed") || is(old, "status", "Pending payment"))) return Result.error("Only a live booking can be corrected");
            if (is(old, "paymentStatus", "Paid") || Js.number(old, "creditApplied") > 0) return Result.error("This booking is already paid (or part-paid from credit). Cancel it with the right refund, then book it again at the correct price.");
            double fee = round2(newFee);
            if (!(fee >= 0) || (newFee.isTextual() && newFee.asText().isEmpty()) || newFee.isMissingNode() || newFee.isNull()) return Result.error("Enter the correct fee");
            if (adjustReason.isEmpty()) return Result.error("Give a reason for the correction");
            double rate = Js.number(old, "gstRate");
            double gst = rate > 0 ? round2(fee - fee / (1 + rate / 100)) : 0;
            double total = round2(fee + Js.number(old, "depositAmount"));
            ObjectNode out = spread(old, clean);
            put(out, "baseAmount", round2(fee - gst)); put(out, "gstAmount", gst); put(out, "feeTotal", fee); put(out, "totalPayable", total);
            double oldRate = Js.number(old, "rate");
            double minRate = Math.min(oldRate != 0 ? oldRate : fee, fee);
            put(out, "rate", minRate != 0 ? minRate : fee);
            put(out, "paymentStatus", total <= 0 ? txt("Not required") : f(old, "paymentStatus"));
            put(out, "status", total <= 0 ? txt("Confirmed") : f(old, "status"));
            put(out, "feeCorrectedFrom", Js.number(old, "feeTotal")); put(out, "feeCorrectionReason", adjustReason); put(out, "feeCorrectedBy", me); put(out, "feeCorrectedAt", nowIso);
            return Result.of(out, act);
        }
        if ("cancel".equals(act)) {
            if (is(old, "status", "Cancelled") || is(old, "status", "Completed")) return Result.error("This booking is already finished");
            JsonNode started = f(old, "startAt");
            String startAt = Js.truthy(started) ? Js.toStr(started) : AmenityEngine.startAtOf(f(old, "date"), f(old, "slot"), amenity);
            if (!staff && AmenityEngine.parseLocal(startAt, zone) < nowMs) return Result.error("This booking has already started");
            boolean waived = staff && waive;
            AmenityEngine.CancelQuote cq = AmenityEngine.cancellationQuote(old, amenity, nowMs, zone, waived);
            double refundFee = cq.refundFee();
            if (staff) {
                double ro = Js.toNumber(refundOverride);
                if (!Double.isNaN(ro) && !Double.isInfinite(ro) && !(refundOverride.isTextual() && refundOverride.asText().isEmpty()) && !refundOverride.isMissingNode() && !refundOverride.isNull())
                    refundFee = Math.min(cq.feePaid(), Math.max(0, round2(refundOverride)));
            }
            double refund = round2(refundFee + cq.refundDeposit());
            boolean credit = !is(settings, "refundMode", AmenityEngine.DEFAULT_REFUND_MODE);
            boolean wasPaid = is(old, "paymentStatus", "Paid");
            boolean viaCredit = is(old, "paymentMode", "Unit credit") || Js.number(old, "creditApplied") > 0;
            // the guest picks where a refund goes; the community setting is only the default. Paid (even partly) from unit credit -> back to the account.
            boolean wantCredit = Js.truthy(refundTo) ? Js.strictEq(refundTo, txt("credit")) : credit;
            boolean toAccount = wantCredit || viaCredit;
            if (!wasPaid && Js.number(old, "creditApplied") > 0) {
                // nothing was paid in cash yet, only unit credit was reserved: give it straight back
                ObjectNode out = spread(old, clean);
                put(out, "status", "Cancelled"); put(out, "cancelledAt", nowIso); put(out, "cancelledBy", me); put(out, "cancelReason", or(f(clean, "cancelReason"), txt("")));
                put(out, "refundPct", 100); put(out, "refundFeeAmount", 0); put(out, "depositReturned", 0); put(out, "retainedAmount", 0);
                put(out, "refundAmount", Js.toNumber(f(old, "creditApplied")));
                put(out, "refundTo", "Unit account"); put(out, "refundStatus", "Credited to unit account"); put(out, "creditRestored", true); put(out, "refundDecidedAt", nowIso); put(out, "paymentStatus", "Cancelled");
                put(out, "depositStatus", is(old, "depositStatus", "Awaiting payment") ? txt("None") : f(old, "depositStatus"));
                return Result.of(out, act);
            }
            ObjectNode out = spread(old, clean);
            put(out, "status", "Cancelled"); put(out, "cancelledAt", nowIso); put(out, "cancelledBy", me);
            put(out, "cancelReason", or(f(clean, "cancelReason"), txt(waived ? "Cancelled by the community" : "")));
            put(out, "refundPct", waived ? AmenityEngine.num(100) : cq.pct()); put(out, "refundFeeAmount", refundFee); put(out, "depositReturned", cq.refundDeposit());
            put(out, "retainedAmount", round2(cq.feePaid() - refundFee)); put(out, "refundAmount", refund);
            put(out, "refundTo", refund > 0 ? (toAccount ? "Unit account" : "Original payment mode" + (t(old, "paymentMode") ? " (" + Js.toStr(f(old, "paymentMode")) + ")" : "")) : "");
            put(out, "refundDecidedAt", nowIso);
            put(out, "refundStatus", refund > 0 ? (toAccount ? "Credited to unit account" : "Refund due") : "None");
            put(out, "paymentStatus", !wasPaid ? "Cancelled" : refund <= 0 ? "Paid" : (toAccount ? (refund >= round2(f(old, "totalPayable")) ? "Refunded" : "Partially refunded") : "Refund due"));
            put(out, "depositStatus", is(old, "depositStatus", "Held") ? txt("Returned") : is(old, "depositStatus", "Awaiting payment") ? txt("None") : f(old, "depositStatus"));
            return Result.of(out, act);
        }
        if ("receive_payment".equals(act)) {
            if (!is(old, "paymentStatus", "Pending")) return Result.error("No payment is pending on this booking");
            ObjectNode out = spread(old, clean);
            put(out, "status", "Confirmed"); put(out, "paymentStatus", "Paid"); put(out, "paidAmount", f(old, "totalPayable")); put(out, "paidAt", today);
            put(out, "paymentMode", or(f(clean, "paymentMode"), f(old, "paymentMode"))); put(out, "paymentRef", paymentRef);
            put(out, "depositStatus", Js.number(old, "depositAmount") > 0 ? "Held" : "None");
            return Result.of(out, act);
        }
        if ("mark_refund_paid".equals(act)) {
            if (!is(old, "refundStatus", "Refund due")) return Result.error("No refund is due on this booking");
            boolean partial = round2(old, "refundAmount") < round2(old, "totalPayable");
            JsonNode pm = initiate ? f(old, "paymentMode") : or(payoutMode, or(f(old, "paymentMode"), txt("Cash")));
            if (initiate) {
                if (!in(ONLINE_MODES, pm)) return Result.error(cannotAuto(pm));
                paymentRef = txt(gatewayRef.get());
            }
            if (!in(PAYOUT_ANY, pm)) return Result.error("Choose how the refund was paid");
            if (pm.isTextual() && AmenityEngine.needsRef(pm.asText()) && trimmed(paymentRef).isEmpty()) return Result.error(needRef(pm.asText()));
            ObjectNode out = spread(old, clean);
            put(out, "refundStatus", "Refunded"); put(out, "paymentStatus", partial ? "Partially refunded" : "Refunded"); put(out, "refundPaidAt", today); put(out, "refundPaidBy", me);
            put(out, "refundPayoutMode", pm); put(out, "refundRef", paymentRef);
            if (initiate) { put(out, "refundInitiatedAt", nowIso); put(out, "refundInitiatedBy", me); put(out, "refundVia", "Payment gateway (original mode)"); }
            return Result.of(out, act);
        }
        if ("refund_to_credit".equals(act)) {
            if (!is(old, "refundStatus", "Refund due")) return Result.error("No refund is due on this booking");
            boolean partial = round2(old, "refundAmount") < round2(old, "totalPayable");
            ObjectNode out = spread(old, clean);
            put(out, "refundStatus", "Credited to unit account"); put(out, "refundTo", "Unit account"); put(out, "paymentStatus", partial ? "Partially refunded" : "Refunded");
            put(out, "refundPaidAt", today); put(out, "refundPaidBy", me); put(out, "refundPayoutMode", "Unit credit");
            return Result.of(out, act);
        }
        if ("complete".equals(act)) {
            if (!is(old, "status", "Confirmed")) return Result.error("Only a confirmed booking can be completed");
            ObjectNode out = spread(old, clean);
            put(out, "status", "Completed");
            return Result.of(out, act);
        }
        if ("settle_deposit".equals(act)) {
            if (!is(old, "depositStatus", "Held")) return Result.error("No security deposit is held for this booking");
            if (is(old, "status", "Cancelled")) return Result.error("A cancelled booking already returned its deposit");
            double dep = round2(old, "depositAmount");
            double ded = Math.min(dep, Math.max(0, round2(depositDeduction)));
            String plain = Js.trim(SPACES.matcher(NBSP.matcher(TAGS.matcher(Js.orEmpty(deductionReason)).replaceAll(" ")).replaceAll(" ")).replaceAll(" "));
            if (ded > 0 && plain.isEmpty()) return Result.error("Give a reason for the deduction");
            JsonNode photosIn = f(clean, "depositPhotos");
            ArrayNode photos = photosIn.isArray() ? (ArrayNode) photosIn : F.arrayNode();
            if (ded > 0 && photos.size() == 0) return Result.error("Attach at least one photo as evidence for the deduction");
            double back = round2(dep - ded);
            boolean viaCredit = is(old, "paymentMode", "Unit credit") || Js.number(old, "creditApplied") > 0;
            JsonNode defMode = !is(settings, "refundMode", AmenityEngine.DEFAULT_REFUND_MODE) || viaCredit ? txt("Unit credit") : or(f(old, "paymentMode"), txt("Cash"));
            JsonNode pm = or(payoutMode, defMode);
            if (!in(PAYOUT_WITH_CREDIT, pm)) return Result.error("Choose how the deposit is returned");
            boolean toCredit = Js.strictEq(pm, txt("Unit credit"));
            ObjectNode out = spread(old, clean);
            put(out, "status", is(old, "status", "Confirmed") ? txt("Completed") : f(old, "status"));
            put(out, "depositReturned", back); put(out, "depositDeduction", ded); put(out, "depositDeductionReason", !plain.isEmpty() ? deductionReason : txt("")); out.set("depositPhotos", photos);
            put(out, "depositSettledBy", me); put(out, "depositRefundMode", back > 0 ? pm : txt("")); put(out, "depositSettledAt", today);
            put(out, "depositStatus", ded == 0 ? "Released" : ded >= dep ? "Forfeited" : "Partly forfeited");
            put(out, "depositRefundStatus", back > 0 ? (toCredit ? "Credited to unit account" : "Due") : "None");
            return Result.of(out, act);
        }
        if ("mark_deposit_paid".equals(act)) {
            if (!is(old, "depositRefundStatus", "Due")) return Result.error("No deposit refund is due");
            JsonNode pm = initiate ? f(old, "paymentMode") : or(payoutMode, or(f(old, "depositRefundMode"), txt("Cash")));
            if (initiate) {
                if (!in(ONLINE_MODES, pm)) return Result.error(cannotAuto(pm));
                paymentRef = txt(gatewayRef.get());
            }
            if (pm.isTextual() && AmenityEngine.needsRef(pm.asText()) && trimmed(paymentRef).isEmpty()) return Result.error(needRef(pm.asText()));
            ObjectNode out = spread(old, clean);
            put(out, "depositRefundStatus", "Paid"); put(out, "depositRefundPaidAt", today); put(out, "depositRefundPaidBy", me); put(out, "depositRefundMode", pm); put(out, "depositRefundRef", or(paymentRef, txt("")));
            if (initiate) { put(out, "depositRefundInitiatedAt", nowIso); put(out, "depositRefundVia", "Payment gateway (original mode)"); }
            return Result.of(out, act);
        }
        return Result.error("Unknown action " + Js.toStr(action));
    }

    // ---- a new booking ------------------------------------------------------------------------------------------------------------------

    private static Result newBooking(Ctx ctx, ObjectNode clean, JsonNode record, boolean staff, Principal p, Clock clock, ZoneId zone, long nowMs, String today,
                                     boolean freeOfCharge, String waiveReason, boolean useCredit, JsonNode paymentRef, PaymentVerifier verifier, String bookingId, DefaulterCheck defaulter) {
        JsonNode amenity = find(ctx.catalog(), a -> Js.strictEq(f(a, "name"), f(clean, "amenity")));
        if (amenity == null) return Result.error("Unknown amenity");
        if (Js.strictEq(f(amenity, "active"), BooleanNode.FALSE)) return Result.error("This amenity is not open for booking right now");
        boolean dayBased = is(amenity, "bookingMode", "Full day");
        JsonNode slot = dayBased ? txt("Full day") : f(clean, "slot");
        if (!t(clean, "date") || !Js.truthy(slot)) return Result.error("Choose a date and time slot");
        double cap = Js.number(amenity, "capacity");
        if (cap == 0) cap = 1;
        long taken = ctx.bookings().stream().filter(b -> !is(b, "status", "Cancelled") && Js.strictEq(f(b, "amenity"), f(amenity, "name")) && Js.strictEq(f(b, "date"), f(clean, "date"))
                && (dayBased || Js.strictEq(f(b, "slot"), slot))).count();
        if (taken >= cap) return Result.error("That booking is no longer available.");
        String amenityName = Js.toStr(f(amenity, "name"));
        if (is(amenity, "reservation", "Walk-in (no reservation)") && !staff) return Result.error(amenityName + " needs no reservation. Just walk in.");
        boolean bypass = AmenityEngine.canOverrideRules(amenity, p == null ? null : p.roleId(), staff);
        if (!bypass) {
            String w = AmenityEngine.bookingWindowError(amenity, f(clean, "date"), slot, nowMs, zone);
            if (!w.isEmpty()) return Result.error(w);
            JsonNode prop = find(ctx.properties(), x -> Js.strictEq(f(x, "unit"), f(clean, "unit")));
            JsonNode unitType = prop != null ? or(f(prop, "type"), txt("")) : txt("");
            String lim = AmenityEngine.bookingRulesError(amenity, f(clean, "date"), f(clean, "unit"), unitType, ctx.bookings(), today);
            if (!lim.isEmpty()) return Result.error(lim);
        }
        if (!staff) {
            String hold = defaulter == null ? "" : defaulter.block(f(clean, "unit"));
            if (!hold.isEmpty()) return Result.error(hold);
        } else if (AmenityEngine.startAtOf(f(clean, "date"), slot, amenity).compareTo(today + "T00:00:00") < 0) return Result.error("That date has already passed.");

        JsonNode picks = AmenityEngine.jsonParse(Js.truthy(f(clean, "extras")) ? Js.toStr(f(clean, "extras")) : "{}");
        if (picks == null) picks = F.objectNode();                                                                // JSON.parse failed: {}
        AmenityEngine.Extras ex = AmenityEngine.priceExtras(picks, ctx.items(), ctx.bookings(), f(amenity, "name"), f(clean, "date"), slot);
        if (ex.error() != null) return Result.error(ex.error());
        clean.put("extras", ex.lines().size() > 0 ? Js.stringify(ex.lines()) : ""); put(clean, "extrasTotal", ex.total());
        AmenityEngine.Quote q = AmenityEngine.quote(amenity, f(clean, "date"), ctx.settings(), ex.total(), zone);
        // staff may reserve for an association (or any unit) free of charge: nothing is charged, no deposit is taken, and the value waived is recorded
        boolean association = is(clean, "bookedFor", "Association");
        if (!staff && (association || freeOfCharge)) return Result.error("Only the amenities team can reserve for an association or waive the charges");
        if (association && trimmed(f(clean, "association")).isEmpty()) return Result.error("Name the association");
        if (association) clean.put("unit", "Association · " + Js.trim(Js.toStr(f(clean, "association"))));
        boolean waived = staff && freeOfCharge && q.total() > 0;
        if (waived && waiveReason.isEmpty()) return Result.error("Give a reason for waiving the charges");
        double waivedAmount = waived ? q.total() : 0;
        if (waived) q = q.waived();
        JsonNode mode = or(f(clean, "paymentMode"), txt(AmenityEngine.defaultOnlineMode()));
        String paymentStatus, status;
        double creditApplied = 0;
        // unit credit can cover all of a booking or part of it (the rest is paid in the chosen mode)
        if (q.total() > 0 && useCredit) creditApplied = Math.min(round2(AmenityEngine.creditBalance(ctx.credits(), f(clean, "unit"))), q.total());
        if (creditApplied < 0.01) creditApplied = 0;
        double remaining = round2(q.total() - creditApplied);
        if (q.total() <= 0) { paymentStatus = "Not required"; status = "Confirmed"; mode = txt(""); }
        else if (creditApplied > 0 && remaining <= 0) { paymentStatus = "Paid"; status = "Confirmed"; mode = txt("Unit credit"); }
        else if (in(ONLINE_MODES, mode)) {
            if (verifier != null) {
                String why = verifier.verify(Js.truthy(paymentRef) ? Js.toStr(paymentRef) : "", Js.truthy(f(clean, "unit")) ? Js.toStr(f(clean, "unit")) : "", remaining, bookingId == null ? "" : bookingId);
                if (why != null && !why.isEmpty()) return Result.error(why);
            }
            paymentStatus = "Paid"; status = "Confirmed";
        }
        else if (in(OFFICE_MODES, mode)) { paymentStatus = staff ? "Paid" : "Pending"; status = "Paid".equals(paymentStatus) ? "Confirmed" : "Pending payment"; }
        else return Result.error("Choose a payment option");
        boolean paid = "Paid".equals(paymentStatus);
        ObjectNode out = spread(clean);
        put(out, "slot", slot); put(out, "status", status); put(out, "paymentMode", mode); put(out, "paymentStatus", paymentStatus);
        put(out, "rate", q.rate()); put(out, "rateUnit", q.rateUnit()); put(out, "qty", 1); put(out, "baseAmount", q.base()); put(out, "gstRate", q.gstRate()); put(out, "gstAmount", q.gst());
        put(out, "gstMode", q.gstMode()); put(out, "feeTotal", q.fee());
        put(out, "depositAmount", q.deposit()); put(out, "totalPayable", q.total()); put(out, "paidAmount", paid ? q.total() : 0); put(out, "paidAt", paid ? today : "");
        put(out, "creditApplied", creditApplied); put(out, "paymentRef", or(paymentRef, txt("")));
        put(out, "depositStatus", q.deposit() > 0 ? (paid ? "Held" : "Awaiting payment") : "None"); put(out, "refundStatus", "None"); put(out, "refundAmount", 0);
        put(out, "startAt", AmenityEngine.startAtOf(f(clean, "date"), slot, amenity)); out.set("policySnapshot", AmenityEngine.tiersJson(amenity)); put(out, "bookedBy", name(p));
        if (association) { put(out, "bookedFor", "Association"); put(out, "association", Js.trim(Js.toStr(f(clean, "association")))); } else put(out, "bookedFor", "Unit");
        if (waivedAmount > 0) { put(out, "chargeWaived", true); put(out, "waivedAmount", waivedAmount); put(out, "waiveReason", waiveReason); }
        return Result.of(out, "create");
    }
}
