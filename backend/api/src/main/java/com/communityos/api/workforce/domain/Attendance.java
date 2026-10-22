package com.communityos.api.workforce.domain;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
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

    // ---- the gate beside the clock ------------------------------------------------------------------------------------------------------------
    /** A staff member's stay inside the gate (their badge in and out; out is null while still inside). */
    public record GateStay(UUID memberId, String name, Instant in, Instant out) {}
    /** One line of the report: a session (null for a day seen only at the gate), that day's gate times, and what does not add up. */
    public record ReportLine(Session session, UUID memberId, String staffName, LocalDate date, Instant gateIn, Instant gateOut, boolean gateInside, BigDecimal gateHours, List<String> flags) {}
    public static final String NO_GATE = "No gate entry", BEFORE_GATE = "Clocked in before the gate", LEFT_EARLY = "Left the gate before clocking out",
        LEFT_CLOCKED = "Left without clocking out", STAYED = "Inside after clocking out", GATE_ONLY = "At the gate, not clocked in";

    /** How far from a session a badge still belongs to it (an early arrival, a late leaving). */
    public static final Duration NEAR = Duration.ofHours(4);

    /**
     * The attendance report with the gate. Each badge stay goes to the person's session it falls in or near (within four hours either side;
     * the closest clock-in wins), so a night shift across midnight keeps its gate times; stays near no session are days seen only at the gate.
     * A session's first badge-in and last badge-out are set beside its clock-in and clock-out with `toleranceMin` either way. "No gate entry"
     * is only said from the first staff badge on (a community that does not use badges, or did not yet, gets no such flags). Any order in, newest first out.
     */
    public static List<ReportLine> withGate(List<Session> sessions, List<GateStay> stays, ZoneId zone, int toleranceMin, Instant now) {
        Duration tol = Duration.ofMinutes(Math.max(0, toleranceMin));
        Map<Session, List<GateStay>> mine = new LinkedHashMap<>();
        for (Session x : sessions) mine.put(x, new ArrayList<>());
        record Key(UUID member, LocalDate date) {}
        Map<Key, List<GateStay>> loose = new LinkedHashMap<>();
        for (GateStay g : stays) {
            if (g.in() == null || g.memberId() == null) continue;
            Session best = null;
            for (Session x : sessions) {
                if (!g.memberId().equals(x.memberId)) continue;
                Instant end = x.clockOut == null ? now : x.clockOut;
                if (g.in().isBefore(x.clockIn.minus(NEAR)) || g.in().isAfter(end.plus(NEAR))) continue;
                if (best == null || Duration.between(x.clockIn, g.in()).abs().compareTo(Duration.between(best.clockIn, g.in()).abs()) < 0) best = x;
            }
            if (best != null) mine.get(best).add(g);
            else loose.computeIfAbsent(new Key(g.memberId(), LocalDate.ofInstant(g.in(), zone)), (k) -> new ArrayList<>()).add(g);
        }
        // the gate records staff from its first badge on: sessions before that are not "missing" a badge
        Instant firstBadge = stays.stream().filter((g) -> g.memberId() != null).map(GateStay::in).filter(java.util.Objects::nonNull).min(Comparator.naturalOrder()).orElse(null);
        List<ReportLine> out = new ArrayList<>();
        for (Map.Entry<Session, List<GateStay>> e : mine.entrySet()) {
            Session x = e.getKey(); List<GateStay> g = e.getValue();
            Span s = span(g, now);
            List<String> flags = new ArrayList<>();
            if (g.isEmpty()) { if (firstBadge != null && !x.clockIn.isBefore(firstBadge.minus(NEAR))) flags.add(NO_GATE); }
            else {
                if (x.clockIn.isBefore(s.in().minus(tol))) flags.add(BEFORE_GATE);
                if (x.clockOut != null && s.out() != null && s.out().isBefore(x.clockOut.minus(tol))) flags.add(LEFT_EARLY);
                if (x.clockOut == null && s.out() != null) flags.add(LEFT_CLOCKED);
                if (x.clockOut != null && ((s.inside() && now.isAfter(x.clockOut.plus(tol))) || (s.out() != null && s.out().isAfter(x.clockOut.plus(tol))))) flags.add(STAYED);
            }
            out.add(new ReportLine(x, x.memberId, x.staffName, x.date, s.in(), s.out(), s.inside(), s.hours(), List.copyOf(flags)));
        }
        for (Map.Entry<Key, List<GateStay>> e : loose.entrySet()) {
            Span s = span(e.getValue(), now);
            out.add(new ReportLine(null, e.getKey().member(), e.getValue().get(0).name(), e.getKey().date(), s.in(), s.out(), s.inside(), s.hours(), List.of(GATE_ONLY)));
        }
        out.sort(Comparator.comparing(ReportLine::date).reversed().thenComparing(ReportLine::staffName, Comparator.nullsLast(Comparator.naturalOrder())));
        return out;
    }
    /** First in, last out (none while still inside), hours inside (an open stay up to now). */
    private record Span(Instant in, Instant out, boolean inside, BigDecimal hours) {}
    private static Span span(List<GateStay> g, Instant now) {
        if (g.isEmpty()) return new Span(null, null, false, null);
        boolean inside = g.stream().anyMatch((x) -> x.out() == null);
        return new Span(g.stream().map(GateStay::in).min(Comparator.naturalOrder()).orElseThrow(),
            inside ? null : g.stream().map(GateStay::out).max(Comparator.naturalOrder()).orElseThrow(), inside,
            g.stream().map((x) -> hours(x.in(), x.out() == null ? now : x.out())).reduce(BigDecimal.ZERO, BigDecimal::add));
    }
}
