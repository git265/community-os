package com.communityos.api.workforce.application;

import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.workforce.application.port.AttendanceStore;
import com.communityos.api.workforce.domain.Attendance;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.UUID;

/**
 * Attendance. Staff clock themselves in and out, at the server's time (never a time the phone sends), one open session at a time; where they
 * were is checked against the site as strictly as the community chose (record only / location needed / inside the site). Lateness is worked
 * out from the shift they are on (planned, else usual) and the grace period. Supervisors see everyone, correct a session with a reason, or
 * remove one; staff see their own.
 */
public final class AttendanceService {
    public record Position(BigDecimal lat, BigDecimal lng, BigDecimal acc) {}
    public record Correction(Instant clockIn, Instant clockOut, String reason) {}

    private final AttendanceStore store; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public AttendanceService(AttendanceStore store, AuditWriter audit, Tx tx, Clock clock) { this.store = store; this.audit = audit; this.tx = tx; this.clock = clock; }
    static final DateTimeFormatter HM = DateTimeFormatter.ofPattern("HH:mm");

    public List<Attendance.Session> list(Caller c, LocalDate from, LocalDate to, UUID memberId) {
        if (!WorkforcePolicy.reader(c)) throw new AccessDenied("Residents do not have attendance records");
        UUID who = WorkforcePolicy.supervisor(c) ? memberId : c.membership().value();
        return store.sessions(from, to, who);
    }
    /** The report: sessions with the gate's badge-in and badge-out beside them (same scope as the list: supervisors all, staff their own). */
    public List<Attendance.ReportLine> report(Caller c, LocalDate from, LocalDate to, UUID memberId) {
        if (!WorkforcePolicy.reader(c)) throw new AccessDenied("Residents do not have attendance records");
        if (from != null && to != null && to.isBefore(from)) throw new DomainException.RuleViolated("bad-period", "The period ends before it starts");
        if (from != null && to != null && from.plusDays(366).isBefore(to)) throw new DomainException.RuleViolated("period-too-long", "Choose a period of up to a year");
        UUID who = WorkforcePolicy.supervisor(c) ? memberId : c.membership().value();
        // badges a day either side, so a night shift's gate times are found; days seen only at the gate stay inside the period
        List<Attendance.GateStay> stays = store.gateStays(from == null ? null : from.minusDays(1), to == null ? null : to.plusDays(1), who, clock.getZone());
        return Attendance.withGate(store.sessions(from, to, who), stays, clock.getZone(), store.settings().graceMinutes(), clock.instant()).stream()
            .filter((l) -> l.session() != null || ((from == null || !l.date().isBefore(from)) && (to == null || !l.date().isAfter(to)))).toList();
    }
    public Attendance.Session mine(Caller c) {
        if (c.membership() == null) throw new AccessDenied("Sign in first");
        return store.openSession(c.membership().value()).orElse(null);
    }

    public Attendance.Session clockIn(Caller c, Position p, String shiftType, String note) {
        if (!WorkforcePolicy.clocks(c)) throw new AccessDenied("Only staff clock in and out");
        Attendance.Settings s = store.settings();
        Attendance.Fix fix = fix(p, s);
        require(s, fix, true);
        return tx.inTx(() -> {
            UUID me = c.membership().value();
            store.openSession(me).ifPresent((o) -> { throw new DomainException.RuleViolated("already-in", "You are clocked in since " + HM.format(o.clockIn.atZone(clock.getZone())) + " - clock out first"); });
            Instant now = clock.instant();
            LocalDate today = LocalDate.ofInstant(now, clock.getZone());
            String shift = shiftType != null && !shiftType.isBlank() ? shiftType.strip() : store.shiftOf(me, today);
            Attendance.Session x = new Attendance.Session();
            x.memberId = me; x.staffName = c.displayName(); x.roleName = store.roleName(me); x.date = today; x.clockIn = now; x.in = fix; x.source = "Self";
            x.shiftType = shift; x.lateMin = Attendance.lateMinutes(shift, s, now, clock.getZone()); x.note = note == null || note.isBlank() ? null : note.strip();
            store.insert(x);
            store.onDuty(me, true);
            audit.write(c, AuditWriter.Action.Create, "workforce.attendance_session", x.id, x.shortId, null,
                c.displayName() + " clocked in" + (fix.site() == null ? "" : " (" + fix.site().toLowerCase() + ")") + (x.lateMin > 0 ? ", " + x.lateMin + " min late" : ""), List.of());
            return x;
        });
    }

    public Attendance.Session clockOut(Caller c, Position p, String note) {
        if (!WorkforcePolicy.clocks(c)) throw new AccessDenied("Only staff clock in and out");
        Attendance.Settings s = store.settings();
        Attendance.Fix fix = fix(p, s);
        require(s, fix, false);
        return tx.inTx(() -> {
            UUID me = c.membership().value();
            Attendance.Session x = store.openSession(me).orElseThrow(() -> new DomainException.RuleViolated("not-in", "You are not clocked in"));
            Instant now = clock.instant();
            x.clockOut = now; x.out = fix; x.hours = Attendance.hours(x.clockIn, now);
            if (note != null && !note.isBlank()) x.note = (x.note == null ? "" : x.note + " · ") + note.strip();
            if (!store.update(x)) throw new DomainException.Conflict("Your attendance");
            store.onDuty(me, false);
            audit.write(c, AuditWriter.Action.Update, "workforce.attendance_session", x.id, x.shortId, null, c.displayName() + " clocked out after " + x.hours + " h", List.of());
            return x;
        });
    }

    /** What a staff member's punch on an entry device did to their attendance. */
    public record DevicePunch(UUID sessionId, String outcome) {}
    /**
     * A staff member's punch on an entry device (the site's device layer calls this as the system): In opens their session at the device's time
     * unless one is already open (from the app, say), Out closes the open one. The device stands at the gate, so the place is "Inside site".
     */
    public DevicePunch devicePunch(Caller system, UUID memberId, String name, boolean in, Instant at, String device) {
        if (system.category() != Caller.Category.System) throw new AccessDenied("Only the device layer records device punches");
        return tx.inTx(() -> {
            Attendance.Settings s = store.settings();
            Attendance.Fix here = new Attendance.Fix(null, null, null, "Inside site", null);
            java.util.Optional<Attendance.Session> open = store.openSession(memberId);
            if (in) {
                if (open.isPresent()) return new DevicePunch(open.get().id, "Already on duty since " + HM.format(open.get().clockIn.atZone(clock.getZone())));
                LocalDate day = LocalDate.ofInstant(at, clock.getZone());
                Attendance.Session x = new Attendance.Session();
                x.memberId = memberId; x.staffName = name; x.roleName = store.roleName(memberId); x.date = day; x.clockIn = at; x.in = here; x.source = "Device";
                x.shiftType = store.shiftOf(memberId, day); x.lateMin = Attendance.lateMinutes(x.shiftType, s, at, clock.getZone()); x.note = "In at " + device;
                store.insert(x);
                store.onDuty(memberId, true);
                audit.write(system, AuditWriter.Action.Create, "workforce.attendance_session", x.id, x.shortId, null, name + " clocked in at " + device + (x.lateMin > 0 ? ", " + x.lateMin + " min late" : ""), List.of());
                return new DevicePunch(x.id, "On duty" + (x.lateMin > 0 ? ", " + x.lateMin + " min late" : ""));
            }
            if (open.isEmpty()) return new DevicePunch(null, "Was not on duty: nothing to close");
            Attendance.Session x = open.get();
            x.clockOut = at.isAfter(x.clockIn) ? at : x.clockIn.plusSeconds(60); x.out = here; x.hours = Attendance.hours(x.clockIn, x.clockOut);
            x.note = (x.note == null ? "" : x.note + " · ") + "Out at " + device;
            if (!store.update(x)) throw new DomainException.Conflict("The attendance of " + name);
            store.onDuty(memberId, false);
            audit.write(system, AuditWriter.Action.Update, "workforce.attendance_session", x.id, x.shortId, null, name + " clocked out at " + device + " after " + x.hours + " h", List.of());
            return new DevicePunch(x.id, "Off duty after " + x.hours + " h");
        });
    }
    /** Is this staff member on duty now (an open session)? */
    public boolean onDuty(UUID memberId) { return store.openSession(memberId).isPresent(); }

    /** A supervisor's correction: the times as they were, and why. */
    public Attendance.Session correct(Caller c, UUID id, long version, Correction f) {
        if (!WorkforcePolicy.supervisor(c)) throw new AccessDenied("Only a supervisor corrects attendance");
        if (f.reason() == null || f.reason().isBlank()) throw new DomainException.RuleViolated("reason-required", "Say why the entry is corrected");
        if (f.clockIn() == null) throw new DomainException.RuleViolated("clock-in-required", "When did they clock in?");
        if (f.clockOut() != null && !f.clockOut().isAfter(f.clockIn())) throw new DomainException.RuleViolated("bad-times", "Clock-out is after clock-in");
        Instant now = clock.instant();
        if (f.clockIn().isAfter(now) || (f.clockOut() != null && f.clockOut().isAfter(now))) throw new DomainException.RuleViolated("future", "Not in the future");
        if (f.clockOut() != null && Attendance.hours(f.clockIn(), f.clockOut()).compareTo(BigDecimal.valueOf(24)) > 0) throw new DomainException.RuleViolated("too-long", "A session is up to 24 hours");
        return tx.inTx(() -> {
            Attendance.Session x = store.session(id, true).orElseThrow(() -> new DomainException.NotFound("Attendance entry"));
            if (x.version != version) throw new DomainException.Conflict("The entry");
            if (f.clockOut() == null && x.clockOut != null) throw new DomainException.RuleViolated("keep-closed", "A closed entry stays closed - give its clock-out time");
            String was = HM.format(x.clockIn.atZone(clock.getZone())) + "-" + (x.clockOut == null ? "open" : HM.format(x.clockOut.atZone(clock.getZone())));
            x.clockIn = f.clockIn(); x.clockOut = f.clockOut(); x.date = LocalDate.ofInstant(f.clockIn(), clock.getZone()); x.hours = f.clockOut() == null ? null : Attendance.hours(f.clockIn(), f.clockOut());
            x.source = "Supervisor"; x.correctedById = c.membership().value(); x.correctionNote = f.reason().strip();
            if (!store.update(x)) throw new DomainException.Conflict("The entry");
            if (x.clockOut != null && store.openSession(x.memberId).isEmpty()) store.onDuty(x.memberId, false);
            audit.write(c, AuditWriter.Action.Update, "workforce.attendance_session", x.id, x.shortId, null,
                "Corrected " + x.staffName + "'s attendance (" + was + " -> " + HM.format(x.clockIn.atZone(clock.getZone())) + "-" + (x.clockOut == null ? "open" : HM.format(x.clockOut.atZone(clock.getZone()))) + "): " + x.correctionNote, List.of());
            return x;
        });
    }

    public void remove(Caller c, UUID id, long version) {
        if (!WorkforcePolicy.supervisor(c)) throw new AccessDenied("Only a supervisor deletes an attendance entry");
        tx.run(() -> {
            Attendance.Session x = store.session(id, true).orElseThrow(() -> new DomainException.NotFound("Attendance entry"));
            if (!store.delete(id, version)) throw new DomainException.Conflict("The entry");
            if (x.open()) store.onDuty(x.memberId, false);
            audit.write(c, AuditWriter.Action.Delete, "workforce.attendance_session", x.id, x.shortId, null, "Deleted " + x.staffName + "'s attendance on " + x.date, List.of());
        });
    }

    /** The server closes a session someone forgot, at the longest shift the community allows (the job; `Auto-closed`, so a supervisor can see and correct it). */
    public int closeOverdue(Caller system) {
        return tx.inTx(() -> {
            BigDecimal max = store.settings().maxShiftHours();
            int n = 0;
            for (Attendance.Session x : store.overdue()) {
                x.clockOut = x.clockIn.plusSeconds(max.multiply(BigDecimal.valueOf(3600)).longValue()); x.hours = Attendance.hours(x.clockIn, x.clockOut); x.source = "Auto-closed";
                x.note = (x.note == null ? "" : x.note + " · ") + "Closed by the server after " + max.stripTrailingZeros().toPlainString() + " h (no clock-out)";
                if (store.update(x)) { store.onDuty(x.memberId, false); n++; }
                audit.write(system, AuditWriter.Action.Update, "workforce.attendance_session", x.id, x.shortId, null, x.staffName + "'s session closed (no clock-out)", List.of());
            }
            return n;
        });
    }

    public List<AttendanceStore.Team> teams(Caller c) { if (!WorkforcePolicy.member(c)) throw new AccessDenied("Members only"); return store.teams(); }

    static Attendance.Fix fix(Position p, Attendance.Settings s) {
        try { return Attendance.fix(p == null ? null : p.lat(), p == null ? null : p.lng(), p == null ? null : p.acc(), s); }
        catch (IllegalArgumentException e) { throw new DomainException.RuleViolated("bad-position", "That position is not on the map"); }
    }
    static void require(Attendance.Settings s, Attendance.Fix fix, boolean in) {
        boolean none = "No location".equals(fix.site());
        if ((Attendance.NEED.equals(s.enforcement()) || (in && Attendance.INSIDE.equals(s.enforcement()))) && none)
            throw new DomainException.RuleViolated("location-required", (in ? "Clock-in" : "Clock-out") + " needs your location - allow location access and try again");
        if (in && Attendance.INSIDE.equals(s.enforcement()) && "Outside site".equals(fix.site()))
            throw new DomainException.RuleViolated("outside-site", "You are " + fix.dist() + " m from the site - clock in when you arrive");
    }
}
