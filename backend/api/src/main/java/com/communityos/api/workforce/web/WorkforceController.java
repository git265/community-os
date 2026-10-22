package com.communityos.api.workforce.web;

import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.communityos.api.workforce.application.AttendanceService;
import com.communityos.api.workforce.application.port.AttendanceStore;
import com.communityos.api.workforce.domain.Attendance;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Attendance: clock in / out (the time is the server's), the list, a supervisor's correction; field staff on duty by team. */
@RestController
@Tag(name = "Workforce")
public class WorkforceController {
    public record ClockRequest(BigDecimal lat, BigDecimal lng, BigDecimal acc, @Size(max = 40) String shiftType, @Size(max = 500) String note) {
        AttendanceService.Position position() { return new AttendanceService.Position(lat, lng, acc); }
    }
    public record CorrectionRequest(@NotNull Instant clockIn, Instant clockOut, @NotNull @Size(min = 1, max = 500) String reason) {}
    public record SessionResponse(UUID id, String shortId, UUID memberId, String staffName, String roleName, LocalDate date, Instant clockIn, Instant clockOut, String note,
                                  Attendance.Fix in, Attendance.Fix out, BigDecimal hours, String source, String shiftType, Integer lateMin, String correctionNote, long version) {
        static SessionResponse of(Attendance.Session x) {
            return new SessionResponse(x.id, x.shortId, x.memberId, x.staffName, x.roleName, x.date, x.clockIn, x.clockOut, x.note, x.in, x.out, x.hours, x.source, x.shiftType, x.lateMin,
                x.correctionNote, x.version);
        }
    }

    private final AttendanceService attendance;
    public WorkforceController(AttendanceService attendance) { this.attendance = attendance; }

    @GetMapping("/api/v1/workforce/attendance")
    public List<SessionResponse> list(@RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to, @RequestParam(required = false) UUID memberId) {
        return attendance.list(CallerHolder.require(), from, to, memberId).stream().map(SessionResponse::of).toList();
    }
    public record ReportLineResponse(SessionResponse session, UUID memberId, String staffName, LocalDate date, Instant gateIn, Instant gateOut, boolean gateInside, BigDecimal gateHours,
                                     List<String> flags) {
        static ReportLineResponse of(Attendance.ReportLine l) {
            return new ReportLineResponse(l.session() == null ? null : SessionResponse.of(l.session()), l.memberId(), l.staffName(), l.date(), l.gateIn(), l.gateOut(), l.gateInside(), l.gateHours(), l.flags());
        }
    }
    /** Attendance with the gate: each session with that day's badge-in and badge-out, days seen only at the gate, and what does not add up. */
    @GetMapping("/api/v1/workforce/attendance/report")
    public List<ReportLineResponse> report(@RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to, @RequestParam(required = false) UUID memberId) {
        return attendance.report(CallerHolder.require(), from, to, memberId).stream().map(ReportLineResponse::of).toList();
    }
    @GetMapping("/api/v1/workforce/attendance/mine")
    public ResponseEntity<SessionResponse> mine() { Attendance.Session x = attendance.mine(CallerHolder.require()); return x == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(SessionResponse.of(x)); }
    @PostMapping("/api/v1/workforce/attendance/clock-in")
    public ResponseEntity<SessionResponse> clockIn(@Valid @RequestBody ClockRequest b) {
        return ResponseEntity.status(201).body(SessionResponse.of(attendance.clockIn(CallerHolder.require(), b.position(), b.shiftType(), b.note())));
    }
    @PostMapping("/api/v1/workforce/attendance/clock-out")
    public SessionResponse clockOut(@Valid @RequestBody ClockRequest b) { return SessionResponse.of(attendance.clockOut(CallerHolder.require(), b.position(), b.note())); }
    @PutMapping("/api/v1/workforce/attendance/{id}")
    public SessionResponse correct(@PathVariable UUID id, @Valid @RequestBody CorrectionRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return SessionResponse.of(attendance.correct(CallerHolder.require(), id, ETags.require(ifMatch), new AttendanceService.Correction(b.clockIn(), b.clockOut(), b.reason())));
    }
    @DeleteMapping("/api/v1/workforce/attendance/{id}")
    public ResponseEntity<Void> remove(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        attendance.remove(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }
    @GetMapping("/api/v1/workforce/teams")
    public List<AttendanceStore.Team> teams() { return attendance.teams(CallerHolder.require()); }
}
