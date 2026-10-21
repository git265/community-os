package com.communityos.api.amenity.domain;

import com.communityos.api.shared.domain.DomainException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The booking arithmetic (the legacy amenityEngine, on BigDecimal): rate -> taxable value -> GST -> fee, plus the refundable deposit; the
 * booking window; the per-unit limits; what cancelling refunds; add-on items priced from the catalog. Pure functions.
 */
public final class Pricing {
    private Pricing() {}
    static final BigDecimal HUNDRED = BigDecimal.valueOf(100);
    public static BigDecimal r2(BigDecimal b) { return (b == null ? BigDecimal.ZERO : b).setScale(2, RoundingMode.HALF_UP); }
    static boolean positive(BigDecimal b) { return b != null && b.signum() > 0; }

    /** What a booking costs. fee = the price with GST; total = fee + deposit. */
    public record Quote(boolean free, boolean weekend, BigDecimal addOn, BigDecimal rate, String rateUnit, BigDecimal base, BigDecimal gstRate, BigDecimal gst, BigDecimal fee,
                        String gstMode, BigDecimal deposit, BigDecimal total) {
        public Quote waived() { return new Quote(true, weekend, addOn, BigDecimal.ZERO, rateUnit, BigDecimal.ZERO.setScale(2), BigDecimal.ZERO, BigDecimal.ZERO.setScale(2), BigDecimal.ZERO.setScale(2), gstMode, BigDecimal.ZERO.setScale(2), BigDecimal.ZERO.setScale(2)); }
    }

    public static Quote quote(AmenityType a, LocalDate date, BigDecimal defaultGstRate, BigDecimal extras) {
        BigDecimal addOn = r2(extras);
        boolean serviceFree = "Free".equals(a.rateUnit()) || !positive(a.rate());
        boolean free = serviceFree && addOn.signum() <= 0;
        boolean weekend = date != null && (date.getDayOfWeek() == DayOfWeek.SATURDAY || date.getDayOfWeek() == DayOfWeek.SUNDAY) && positive(a.weekendRate());
        BigDecimal rate = free ? BigDecimal.ZERO : (serviceFree ? BigDecimal.ZERO : weekend ? a.weekendRate() : a.rate()).add(addOn);
        boolean gstOn = !free && a.gstApplicable();
        BigDecimal gstRate = !gstOn ? BigDecimal.ZERO : a.gstRate() != null ? a.gstRate() : defaultGstRate != null ? defaultGstRate : BigDecimal.valueOf(18);
        String mode = a.gstMode() == null || a.gstMode().isBlank() ? "Exclusive" : a.gstMode();
        BigDecimal base = r2(rate), gst = BigDecimal.ZERO.setScale(2), fee = r2(rate);
        if (gstOn && "Inclusive".equals(mode)) { base = rate.multiply(HUNDRED).divide(HUNDRED.add(gstRate), 2, RoundingMode.HALF_UP); gst = r2(rate).subtract(base); fee = r2(rate); }
        else if (gstOn) { base = r2(rate); gst = r2(base.multiply(gstRate).divide(HUNDRED, 2, RoundingMode.HALF_UP)); fee = base.add(gst); }
        BigDecimal deposit = r2(a.depositAmount());
        return new Quote(free, weekend, addOn, rate, a.rateUnit() == null ? "Per day / event" : a.rateUnit(), base, gstRate, gst, fee, mode, deposit, fee.add(deposit));
    }

    // ---- when it starts ----------------------------------------------------------------------------------------------------------------------
    private static final Pattern HM = Pattern.compile("^(\\d{1,2}):(\\d{2})");
    /** A slot starts at its first time; a full-day booking at the amenity's opening time (or midnight). */
    public static Instant startAt(LocalDate date, String slot, AmenityType a, ZoneId zone) {
        String subject = slot != null && !slot.isBlank() && !"Full day".equals(slot) ? slot : a.hours() == null ? "" : a.hours();
        Matcher m = HM.matcher(subject.strip());
        LocalTime t = LocalTime.MIDNIGHT;
        if (m.find()) { int h = Integer.parseInt(m.group(1)), mi = Integer.parseInt(m.group(2)); if (h < 24 && mi < 60) t = LocalTime.of(h, mi); }
        return date.atTime(t).atZone(zone).toInstant();
    }
    private static final Pattern SLOT = Pattern.compile("^\\d{1,2}:\\d{2}\\s*[-–]\\s*\\d{1,2}:\\d{2}$");
    /** A slot this amenity offers: one of its own, or any "HH:MM–HH:MM" when it lists none. */
    public static String checkSlot(AmenityType a, String slot) {
        if (a.fullDay()) return "Full day";
        if (slot == null || slot.isBlank() || "Full day".equals(slot)) throw new DomainException.RuleViolated("slot-required", "Choose a time slot");
        String s = slot.strip();
        if (!a.slots().isEmpty() ? !a.slots().contains(s) : !SLOT.matcher(s).matches()) throw new DomainException.RuleViolated("bad-slot", a.name() + " has no slot " + s);
        return s;
    }

    // ---- window and limits -------------------------------------------------------------------------------------------------------------------
    public static String windowError(AmenityType a, Instant start, Instant now) {
        double left = Duration.between(now, start).toMinutes() / 60.0;
        if (left < 0) return "That time has already passed.";
        Integer minH = a.minNoticeHours(), maxD = a.maxAdvanceDays();
        if (minH != null && minH > 0 && left < minH) return "This amenity must be booked at least " + minH + " hour" + (minH == 1 ? "" : "s") + " ahead.";
        if (maxD != null && maxD > 0 && left > maxD * 24.0) return "This amenity can be booked at most " + maxD + " days ahead.";
        return null;
    }
    /** A unit's own live bookings of this amenity (not cancelled): their dates and whether they are done. */
    public record Held(LocalDate date, boolean completed) {}
    public static String limitsError(AmenityType a, LocalDate date, String unitType, List<Held> mine, LocalDate today) {
        if (a.blackoutDates().contains(date.toString())) return a.name() + " is closed on " + date + ".";
        if (!a.allowedUnitTypes().isEmpty() && unitType != null && !unitType.isBlank() && !a.allowedUnitTypes().contains(unitType))
            return a.name() + " can be booked by " + String.join(" / ", a.allowedUnitTypes()).toLowerCase() + " units only.";
        if (positive(a.maxPerDay()) && mine.stream().filter((h) -> h.date().equals(date)).count() >= a.maxPerDay().longValue())
            return "One unit can hold at most " + a.maxPerDay().stripTrailingZeros().toPlainString() + " booking" + (a.maxPerDay().intValue() == 1 ? "" : "s") + " a day for " + a.name() + ".";
        if (positive(a.maxPerMonth()) && mine.stream().filter((h) -> h.date().getYear() == date.getYear() && h.date().getMonth() == date.getMonth()).count() >= a.maxPerMonth().longValue())
            return "One unit can book " + a.name() + " at most " + a.maxPerMonth().stripTrailingZeros().toPlainString() + " time" + (a.maxPerMonth().intValue() == 1 ? "" : "s") + " a month.";
        if (positive(a.maxUpcoming()) && mine.stream().filter((h) -> !h.date().isBefore(today) && !h.completed()).count() >= a.maxUpcoming().longValue())
            return "You already hold " + a.maxUpcoming().stripTrailingZeros().toPlainString() + " upcoming booking" + (a.maxUpcoming().intValue() == 1 ? "" : "s") + " for " + a.name() + ". Use or cancel one first.";
        return null;
    }
    /** The amenity's team may ignore the window and limits: the Super Admin always; other staff when the amenity names their role (or names none). */
    public static boolean mayOverride(AmenityType a, boolean staff, boolean superAdmin, java.util.Set<String> roles) {
        if (!staff) return false;
        if (superAdmin || a.overrideRoles().isEmpty()) return true;
        return roles.stream().anyMatch(a.overrideRoles()::contains);
    }

    // ---- cancelling ----------------------------------------------------------------------------------------------------------------------------
    public record CancelQuote(BigDecimal pct, BigDecimal refundFee, BigDecimal refundDeposit) {}
    /** The fee is refunded by the tier of notice given; the deposit always comes back in full; a waived cancellation refunds everything. */
    public static CancelQuote cancellation(List<AmenityType.Tier> tiers, Instant start, Instant now, BigDecimal feePaid, BigDecimal depositPaid, boolean waive) {
        double left = Duration.between(now, start).toMinutes() / 60.0;
        BigDecimal pct = BigDecimal.ZERO;
        if (waive) pct = HUNDRED;
        else for (AmenityType.Tier t : tiers) if (left >= t.hoursBefore().doubleValue()) { pct = t.refundPct(); break; }
        return new CancelQuote(pct, r2(r2(feePaid).multiply(pct).divide(HUNDRED, 2, RoundingMode.HALF_UP)), r2(depositPaid));
    }

    // ---- add-on items --------------------------------------------------------------------------------------------------------------------------
    public record Item(UUID id, String name, UUID amenityTypeId, BigDecimal stock, BigDecimal price, BigDecimal maxPerBooking, boolean active) {}
    /** A booked line: what, how many, the price each and the line amount (priced from the catalog, never from the browser). */
    public record Line(UUID itemId, String name, int qty, BigDecimal price, BigDecimal amount) {}
    public record Extras(List<Line> lines, BigDecimal total) {}
    /** heldElsewhere = how many of each item other live bookings hold at an overlapping time. */
    public static Extras price(Map<UUID, Integer> picks, List<Item> catalog, UUID amenityTypeId, Map<UUID, Integer> heldElsewhere) {
        List<Line> lines = new java.util.ArrayList<>();
        BigDecimal total = BigDecimal.ZERO;
        for (Map.Entry<UUID, Integer> e : (picks == null ? Map.<UUID, Integer>of() : picks).entrySet()) {
            int qty = e.getValue() == null ? 0 : e.getValue();
            if (qty <= 0) continue;
            Item it = catalog.stream().filter((i) -> i.id().equals(e.getKey()) && i.active() && (i.amenityTypeId() == null || i.amenityTypeId().equals(amenityTypeId))).findFirst()
                .orElseThrow(() -> new DomainException.RuleViolated("bad-item", "One of the add-on items is not available for this amenity"));
            if (positive(it.maxPerBooking()) && qty > it.maxPerBooking().intValue()) throw new DomainException.RuleViolated("too-many", "At most " + it.maxPerBooking().intValue() + " " + it.name().toLowerCase() + " per booking");
            int left = Math.max(0, (it.stock() == null ? 0 : it.stock().intValue()) - heldElsewhere.getOrDefault(it.id(), 0));
            if (qty > left) throw new DomainException.RuleViolated("sold-out", "Only " + left + " " + it.name().toLowerCase() + " left for that time");
            BigDecimal amount = r2(it.price() == null ? BigDecimal.ZERO : it.price().multiply(BigDecimal.valueOf(qty)));
            lines.add(new Line(it.id(), it.name(), qty, r2(it.price()), amount));
            total = total.add(amount);
        }
        return new Extras(List.copyOf(lines), r2(total));
    }
}
