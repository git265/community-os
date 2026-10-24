package com.communityos.api.gate.application.port;

import com.communityos.api.gate.domain.Gate;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.time.Instant;
import java.time.LocalTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port: what the gate rules read from the registers (settings, villa rules, the vetted registry, household links, crews, checkpoints). */
public interface GateDirectory {
    record UnitRef(UnitId id, String unitNo, BlockId block) {}
    /** hasTag: an NFC tag is fitted at the post. */
    record Checkpoint(UUID id, String name, String code, boolean active, Double lat, Double lng, Integer radiusM, boolean hasTag) {}
    record Round(UUID id, String name, LocalTime time, int windowMin, List<UUID> checkpointIds, List<String> days, boolean active) {}
    /** A guard clocked in now, and when their console was last used (null: not since they clocked in). */
    record OnDuty(UUID memberId, String name, Instant clockIn, Instant lastBeat) {}
    Gate.Settings settings();
    Gate.UnitRule unitRule(UnitId unit);
    /** Add a company to a villa's allow-list ("always allow" on a delivery). */
    void allowCompany(UnitId unit, String company);
    Optional<Gate.Person> person(UUID id);
    /** A membership as the gate sees it (name, role, still active, on the staff). */
    Optional<Gate.Staff> staff(UUID memberId);
    List<Gate.Link> links(UUID personId);
    List<Gate.WorkOrder> activeWorkOrders();
    Optional<UnitRef> unit(UnitId unit);
    Optional<Checkpoint> checkpoint(UUID id);
    /** The checkpoint whose NFC tag has this hash (Gate.tagHash). */
    Optional<Checkpoint> checkpointByTag(String hash);
    /** How this community uses NFC tags on patrols (Gate.PATROL_NFC). */
    String patrolNfc();
    List<Round> rounds();
    /** The guard console's heartbeat (one row per guard). */
    void beat(UUID guardId, String kind);
    /** A registered vehicle by its plate (spaces and case ignored). */
    Optional<Gate.Vehicle> vehicleByPlate(String normalisedPlate);
    /** The person no longer works for this unit (their household link ends). */
    void endLink(UUID personId, UnitId unit);
    /** Guards (security staff) clocked in right now. */
    List<OnDuty> guardsOnDuty();
    /** Was any guard clocked in at some point between these times? */
    boolean guardOnDutyBetween(Instant from, Instant to);
}
