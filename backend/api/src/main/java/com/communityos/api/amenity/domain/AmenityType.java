package com.communityos.api.amenity.domain;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/** An amenity as the booking rules read it (the register itself is a resource: AmenityResources.TYPES). */
public record AmenityType(UUID id, String name, boolean active, BigDecimal rate, String rateUnit, BigDecimal weekendRate, boolean gstApplicable, BigDecimal gstRate,
                          String gstMode, BigDecimal depositAmount, List<Tier> cancellationRules, Integer minNoticeHours, Integer maxAdvanceDays, int capacity, String hours,
                          String bookingMode, String reservation, List<String> overrideRoles, BigDecimal maxPerDay, BigDecimal maxPerMonth, BigDecimal maxUpcoming,
                          List<String> blackoutDates, List<String> allowedUnitTypes, List<String> slots) {
    /** A cancellation tier: cancelling at least hoursBefore ahead refunds refundPct of the fee. */
    public record Tier(BigDecimal hoursBefore, BigDecimal refundPct) {}
    public static final List<Tier> DEFAULT_TIERS = List.of(new Tier(BigDecimal.valueOf(72), BigDecimal.valueOf(100)), new Tier(BigDecimal.valueOf(24), BigDecimal.valueOf(50)),
        new Tier(BigDecimal.ZERO, BigDecimal.ZERO));

    public AmenityType {
        cancellationRules = cancellationRules == null ? List.of() : List.copyOf(cancellationRules); overrideRoles = overrideRoles == null ? List.of() : List.copyOf(overrideRoles);
        blackoutDates = blackoutDates == null ? List.of() : List.copyOf(blackoutDates); allowedUnitTypes = allowedUnitTypes == null ? List.of() : List.copyOf(allowedUnitTypes);
        slots = slots == null ? List.of() : List.copyOf(slots); capacity = Math.max(1, capacity);
    }
    public boolean fullDay() { return "Full day".equals(bookingMode); }
    public boolean walkIn() { return "Walk-in (no reservation)".equals(reservation); }
    /** Tiers cleaned and sorted, longest notice first; the community default when none are set. */
    public List<Tier> tiers() {
        List<Tier> in = cancellationRules.isEmpty() ? DEFAULT_TIERS : cancellationRules;
        return in.stream().map((t) -> new Tier(max0(t.hoursBefore()), clamp(t.refundPct()))).sorted((a, b) -> b.hoursBefore().compareTo(a.hoursBefore())).toList();
    }
    static BigDecimal max0(BigDecimal b) { return b == null || b.signum() < 0 ? BigDecimal.ZERO : b; }
    static BigDecimal clamp(BigDecimal b) { return b == null || b.signum() < 0 ? BigDecimal.ZERO : b.min(BigDecimal.valueOf(100)); }
}
