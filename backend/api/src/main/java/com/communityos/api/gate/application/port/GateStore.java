package com.communityos.api.gate.application.port;

import com.communityos.api.gate.domain.Gate;
import com.communityos.api.shared.access.Spec;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port: the gate's records - passes, visits, approvals, flags, patrol scans - in the caller's community. */
public interface GateStore {
    record VisitFilter(String state, UUID unit, LocalDate from, LocalDate to, boolean openOnly) {}
    /** lat/lng/accM: the phone's GPS at the scan; distM: how far that is from the post; place: what that means (Gate.SCAN_PLACES). */
    record Scan(UUID checkpointId, String checkpointName, UUID guardId, String guard, Instant at, UUID roundId, String roundName, LocalDate day, String note,
                Double lat, Double lng, Integer accM, Integer distM, String place) {}

    // passes
    List<Gate.Pass> passes(Spec<Gate.Pass> scope, String status);
    Optional<Gate.Pass> pass(UUID id, Spec<Gate.Pass> scope);
    List<Gate.Pass> passesMatching(String codeOrName);
    boolean codeInUse(String code);
    void insert(Gate.Pass p);
    boolean save(Gate.Pass p);
    // visits
    List<Gate.Visit> visits(Spec<Gate.Visit> scope, VisitFilter f);
    Optional<Gate.Visit> visit(UUID id, Spec<Gate.Visit> scope);
    /** A staff member's open visit. */
    Optional<Gate.Visit> insideByMember(UUID member);
    /** The community's badge key (made on first use). */
    byte[] badgeKey();
    /** Mark a badge window used for this member; false when it (or a later one) was used already. Locks the member's row. */
    boolean useBadge(UUID member, long window);
    Optional<Gate.Visit> insideByPerson(UUID personId);
    Optional<Gate.Visit> insideByPass(UUID passId);
    /** A registered vehicle's open entry, by its plate (spaces and case ignored). */
    Optional<Gate.Visit> insideByPlate(String normalisedPlate);
    /** Inside and past the time they were expected out. */
    List<Gate.Visit> overdue(Instant before);
    void insert(Gate.Visit v);
    boolean save(Gate.Visit v);
    // approvals
    List<Gate.Approval> approvals(Spec<Gate.Approval> scope, String status);
    Optional<Gate.Approval> approval(UUID id, Spec<Gate.Approval> scope);
    List<Gate.Approval> expired(Instant now);
    void insert(Gate.Approval a);
    boolean save(Gate.Approval a);
    // flags
    List<Gate.Flag> flags(boolean openOnly);
    Optional<Gate.Flag> flag(UUID id);
    boolean hasFlag(String type, UUID visitId);
    /** Open resident reports of a person (the report itself, not the alerts raised when they came to the gate). */
    List<Gate.Flag> openReports(UUID personId);
    /** An open flag of this type about this person raised since then. */
    boolean openFlagSince(String type, String personName, Instant since);
    /** A missed-patrol flag for this round on this day. */
    boolean hasRoundFlag(UUID roundId, LocalDate day);
    void insert(Gate.Flag f);
    boolean save(Gate.Flag f);
    // patrols
    Optional<Scan> lastScanOf(UUID guardId);
    void insert(Scan s);
    List<Scan> scans(UUID roundId, LocalDate day);
    List<Scan> scansSince(LocalDate day);
}
