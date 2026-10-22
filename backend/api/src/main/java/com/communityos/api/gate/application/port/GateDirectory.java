package com.communityos.api.gate.application.port;

import com.communityos.api.gate.domain.Gate;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.time.LocalTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port: what the gate rules read from the registers (settings, villa rules, the vetted registry, household links, crews, checkpoints). */
public interface GateDirectory {
    record UnitRef(UnitId id, String unitNo, BlockId block) {}
    record Checkpoint(UUID id, String name, String code, boolean active) {}
    record Round(UUID id, String name, LocalTime time, int windowMin, List<UUID> checkpointIds, List<String> days, boolean active) {}
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
    List<Round> rounds();
    /** The guard console's heartbeat (one row per guard). */
    void beat(UUID guardId, String kind);
}
