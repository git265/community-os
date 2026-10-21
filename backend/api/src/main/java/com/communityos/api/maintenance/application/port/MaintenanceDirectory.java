package com.communityos.api.maintenance.application.port;

import com.communityos.api.maintenance.domain.TaskType;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/** Reference data and people the ticket rules need, all inside the caller's community. */
public interface MaintenanceDirectory {
    record UnitRef(UnitId id, String unitNo, BlockId block) {}
    /** Someone a ticket may be assigned to: field staff of the trade, the category's coordinators, or (internal tasks) EC members. */
    record Candidate(MembershipId id, String name, String kind, boolean clockedIn, String trade) {}

    List<TaskType> taskTypes();
    Optional<TaskType> taskType(UUID id);
    Optional<UnitRef> unit(UnitId id);
    List<Candidate> candidates(String category, boolean internal);
    /** Role codes that give the final approval (Maintenance → Final approvers); Treasurer + President by default. */
    Set<String> finalApproverRoles();
    Optional<String> memberName(MembershipId id);
}
