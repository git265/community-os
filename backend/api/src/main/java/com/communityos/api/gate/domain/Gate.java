package com.communityos.api.gate.domain;

import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * The gate's vocabulary and its pure rules (the legacy lib/gate/engine.js decisions): entry windows, quiet hours, pass validity, how long a
 * visit may last, what a delivery may do, and the visit's state machine.
 */
public final class Gate {
    private Gate() {}
    public static final List<String> DAYS = List.of("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun");
    public static final List<String> VILLA_CLASSES = List.of("Maid / cook", "Nanny / caretaker", "Driver");
    public static final List<String> CREW_CLASSES = List.of("Daily worker", "Landscaper", "Vendor staff", "Contractor");
    public static final List<String> PERSON_CLASSES = List.of("Maid / cook", "Nanny / caretaker", "Driver", "Delivery rider", "Daily worker", "Landscaper", "Vendor staff", "Contractor", "Other");
    public static final List<String> PERSON_STATUS = List.of("Invited", "Documents pending", "Under review", "Active", "Suspended", "Blocked");
    public static final List<String> VETTED = List.of("Active", "Under review", "Suspended", "Blocked");
    public static final List<String> KINDS = List.of("Guest", "Delivery", "Cab", "Maid / cook", "Driver", "Crew", "Resident vehicle", "Goods vehicle", "Emergency", "Other");
    public static final List<String> PASS_TYPES = List.of("One-time", "Recurring", "Event", "Goods");
    public static final List<String> RESOLUTIONS = List.of("Registered late", "False alarm", "Escorted out", "Escalated to manager");
    public static final List<String> GATES = List.of("Main gate", "Service gate", "Gate 3");

    public static String dayOf(LocalDate d) { return DAYS.get(d.getDayOfWeek().getValue() - 1); }
    /** Days empty = every day; no times = any time; slack widens the window by minutes on each side. */
    public static boolean windowOpen(List<String> days, LocalTime from, LocalTime to, ZonedDateTime now, int slackMin) {
        if (days != null && !days.isEmpty() && !days.contains(dayOf(now.toLocalDate()))) return false;
        int n = now.getHour() * 60 + now.getMinute();
        if (from != null && n < from.getHour() * 60 + from.getMinute() - slackMin) return false;
        return to == null || n <= to.getHour() * 60 + to.getMinute() + slackMin;
    }

    /** The community's gate settings. */
    public record Settings(int waitSeconds, String fallback, int graceSeconds, int overstayGraceMinutes, int autoCloseHours, LocalTime quietFrom, LocalTime quietTo,
                           String quietFallback, String goodsExtraPeople, int patrolMinSeconds, Map<String, Integer> durations, List<String> approvedCompanies) {
        public boolean quiet(ZonedDateTime now) {
            if (quietFrom == null || quietTo == null) return false;
            LocalTime t = now.toLocalTime();
            return quietFrom.isBefore(quietTo) || quietFrom.equals(quietTo) ? !t.isBefore(quietFrom) && t.isBefore(quietTo) : !t.isBefore(quietFrom) || t.isBefore(quietTo);
        }
        public int minutesFor(String kind) { Integer m = durations == null ? null : durations.get(kind); return m != null ? m : "Resident vehicle".equals(kind) ? 0 : 120; }
    }

    /** A villa's own gate rule. */
    public record UnitRule(UnitId unit, String deliveryMode, List<String> companies, Instant expectingUntil, boolean awayMode, String fallback) {
        public static UnitRule defaults(UnitId u) { return new UnitRule(u, "Allow listed", List.of(), null, false, "Community default"); }
    }
    /** A person in the vetted registry. */
    public record Person(UUID id, String name, String personClass, String phone, String photo, String status, String vendor, String deliveryCompany, LocalDate licenceExpiry,
                         LocalDate policeExpiry, String vehicleNo, String statusReason) {}
    /** A household-staff link: this person works for this unit on these days and hours. */
    public record Link(UUID personId, UnitId unit, String unitNo, List<String> days, LocalTime fromTime, LocalTime toTime, String status) {}
    /** A crew work order with its roster. */
    public record WorkOrder(UUID id, String title, String vendor, List<String> days, LocalTime fromTime, LocalTime toTime, List<UUID> rosterIds, String status) {}

    // ---- passes --------------------------------------------------------------------------------------------------------------------------------
    public static final class Pass {
        public UUID id; public String shortId; public String visitorName, phone; public UnitId unit; public String unitNo; public String type = "One-time";
        public LocalDate validFrom, validTo; public LocalTime fromTime, toTime; public List<String> days = List.of(); public String vehicle; public Integer guestCap;
        public String goodsKind; public Integer peopleCount; public String material; public boolean carryingOut; public String outItems; public int usedCount;
        public String code; public String photo; public String hostName; public String status = "Active"; public UUID createdBy; public Instant createdAt; public long version;

        /** Why this pass does not open the gate now ("" when it does). */
        public String problem(ZonedDateTime now) {
            switch (status) { case "Cancelled": return "This pass was cancelled"; case "Used": return "This one-time pass has already been used"; case "Expired": return "This pass has expired"; default: }
            LocalDate t = now.toLocalDate();
            if (validFrom != null && t.isBefore(validFrom)) return "Not valid before " + validFrom;
            if (validTo != null && t.isAfter(validTo)) return "Expired on " + validTo;
            if ("Event".equals(type) && guestCap != null && guestCap > 0 && usedCount >= guestCap) return "Guest limit of " + guestCap + " reached";
            if ("Recurring".equals(type) && !windowOpen(days, fromTime, toTime, now, 0)) return "Outside the days or hours of this pass";
            if (!"Recurring".equals(type) && (fromTime != null || toTime != null) && !windowOpen(List.of(), fromTime, toTime, now, 0)) return "Outside the hours of this pass";
            return "";
        }
        public void used() { usedCount++; if ("One-time".equals(type)) status = "Used"; }
    }

    // ---- visits --------------------------------------------------------------------------------------------------------------------------------
    public enum VisitState {
        AWAITING("Awaiting approval"), APPROVED("Approved"), DENIED("Denied"), NO_ANSWER("No answer"), INSIDE("Inside"), EXITED("Exited"), AUTO_CLOSED("Auto-closed"),
        LEFT_AT_GATE("Left at gate"), REFUSED("Refused");
        public final String label; VisitState(String l) { label = l; }
        @com.fasterxml.jackson.annotation.JsonValue public String json() { return label; }
        public static VisitState of(String s) { for (VisitState v : values()) if (v.label.equals(s)) return v; throw new IllegalArgumentException(s); }
        public boolean canMoveTo(VisitState to) {
            return switch (this) {
                case AWAITING, NO_ANSWER -> Set.of(APPROVED, DENIED, NO_ANSWER, REFUSED, INSIDE, AWAITING).contains(to);
                case APPROVED -> Set.of(INSIDE, REFUSED).contains(to);
                case INSIDE -> Set.of(EXITED, AUTO_CLOSED).contains(to);
                default -> false;
            };
        }
        public boolean finished() { return this == EXITED || this == AUTO_CLOSED || this == LEFT_AT_GATE || this == REFUSED || this == DENIED; }
    }
    public static final class Visit {
        public UUID id; public String shortId; public String name, kind = "Guest"; public UnitId unit; public String unitNo; public String gate = "Main gate"; public String company, vehicle, phone, purpose;
        public VisitState state = VisitState.INSIDE; public String method = "Guard manual"; public Instant inAt, outAt, expectedUntil; public String photo; public UUID personId, passId, workOrderId, approvalId;
        public String note; public Integer headcountExpected, headcountIn, headcountOut; public String material; public boolean carryingOut; public String outItems, openReason, outMethod;
        public UUID verifiedBy; public String verifiedByName; public Instant createdAt; public long version;
        public void move(VisitState to) {
            if (!state.canMoveTo(to)) throw new DomainException.RuleViolated("visit-state", "This visit is " + state.label.toLowerCase() + " - it cannot become " + to.label.toLowerCase());
            state = to;
        }
    }
    public static final class Approval {
        public UUID id; public String shortId; public String name, kind, company, purpose, vehicle, gate, photo; public UnitId unit; public String unitNo; public UUID visitId;
        public String status = "Pending"; public Instant requestedAt, expiresAt, answeredAt; public String fallback; public UUID answeredBy; public String answeredByName;
        public boolean alwaysAllow; public long version;
        public boolean open() { return "Pending".equals(status) || "No answer".equals(status); }
    }
    public static final class Flag {
        public UUID id; public String shortId; public String type, state = "Open", gate, personName; public UnitId unit; public String detail; public Instant raisedAt, graceUntil;
        public UUID visitId, personId, roundId; public String photo; public String resolution, resolutionNote; public UUID resolvedBy; public String resolvedByName; public Instant resolvedAt;
        public LocalDate day; public long version;
    }
}
