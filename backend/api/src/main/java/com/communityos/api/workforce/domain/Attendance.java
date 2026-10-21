package com.communityos.api.workforce.domain;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Map;
import java.util.UUID;

/** Attendance: a session from clock-in to clock-out, where it was made, and the pure rules (distance to the site, lateness, hours). */
public final class Attendance {
    private Attendance() {}
    public static final String RECORD = "Record only (flag exceptions)", NEED = "Require location", INSIDE = "Require location inside the site";

    public static final class Session {
        public UUID id; public String shortId; public UUID memberId; public String staffName; public String roleName; public LocalDate date; public Instant clockIn; public Instant clockOut;
        public String note; public Fix in = Fix.NONE; public Fix out = Fix.NONE; public BigDecimal hours; public String source = "Self"; public String shiftType; public Integer lateMin;
        public UUID correctedById; public String correctionNote; public Instant createdAt; public long version;
        public boolean open() { return clockOut == null; }
    }
    /** Where a clock-in or clock-out was made: the position (if the phone gave one), its accuracy, and inside / outside the site. */
    public record Fix(BigDecimal lat, BigDecimal lng, BigDecimal acc, String site, BigDecimal dist) { public static final Fix NONE = new Fix(null, null, null, null, null); }
    public record Settings(String siteName, BigDecimal siteLat, BigDecimal siteLng, int radiusM, String enforcement, int graceMinutes, Map<String, String> shiftStarts, BigDecimal maxShiftHours) {}

    /** Metres between two points (haversine). */
    public static double distanceM(double lat1, double lng1, double lat2, double lng2) {
        double r = 6_371_000, p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2), dp = Math.toRadians(lat2 - lat1), dl = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
        return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    /** The fix for a position against the site; no position = "No location". */
    public static Fix fix(BigDecimal lat, BigDecimal lng, BigDecimal acc, Settings s) {
        if (lat == null || lng == null) return new Fix(null, null, null, "No location", null);
        if (lat.abs().compareTo(BigDecimal.valueOf(90)) > 0 || lng.abs().compareTo(BigDecimal.valueOf(180)) > 0) throw new IllegalArgumentException("bad position");
        if (s.siteLat() == null || s.siteLng() == null) return new Fix(lat, lng, acc, null, null);
        long d = Math.round(distanceM(lat.doubleValue(), lng.doubleValue(), s.siteLat().doubleValue(), s.siteLng().doubleValue()));
        return new Fix(lat, lng, acc, d <= s.radiusM() ? "Inside site" : "Outside site", BigDecimal.valueOf(d));
    }
    /** Minutes late beyond the grace period for a shift that starts at `start` (none for a night shift, a day off or an unknown shift). */
    public static int lateMinutes(String shift, Settings s, Instant now, ZoneId zone) {
        if (shift == null || shift.equals("Off") || shift.equals("Night")) return 0;
        String start = s.shiftStarts().get(shift);
        if (start == null || !start.matches("([01][0-9]|2[0-3]):[0-5][0-9]")) return 0;
        LocalTime t = LocalTime.parse(start), at = now.atZone(zone).toLocalTime();
        long late = Duration.between(t, at).toMinutes() - s.graceMinutes();
        return late > 0 && at.isAfter(t) ? (int) late : 0;
    }
    public static BigDecimal hours(Instant in, Instant out) { return BigDecimal.valueOf(Duration.between(in, out).getSeconds()).divide(BigDecimal.valueOf(3600), 2, RoundingMode.HALF_UP); }
}
