package com.communityos.api.workforce.application.port;

import com.communityos.api.workforce.domain.Attendance;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Attendance sessions and what clocking in needs to know - explicit SQL behind it (JdbcAttendanceStore). */
public interface AttendanceStore {
    Attendance.Settings settings();
    Optional<Attendance.Session> openSession(UUID memberId);
    /** Sessions still open after the longest shift the community allows (locked). */
    List<Attendance.Session> overdue();
    Optional<Attendance.Session> session(UUID id, boolean lock);
    List<Attendance.Session> sessions(LocalDate from, LocalDate to, UUID memberId);
    /** Staff members' stays inside the gate (badge in and out) that began in the period. */
    List<Attendance.GateStay> gateStays(LocalDate from, LocalDate to, UUID memberId, java.time.ZoneId zone);
    void insert(Attendance.Session s);
    boolean update(Attendance.Session s);
    boolean delete(UUID id, long version);
    /** The shift a member works on a day: the planned one, else their usual shift as field staff, else null. */
    String shiftOf(UUID memberId, LocalDate date);
    /** Field staff's "on duty" flag follows their attendance. */
    void onDuty(UUID memberId, boolean on);
    String roleName(UUID memberId);
    record Team(String team, int onDuty, int total) {}
    /** Field staff by trade: how many are on duty now. */
    List<Team> teams();
}
