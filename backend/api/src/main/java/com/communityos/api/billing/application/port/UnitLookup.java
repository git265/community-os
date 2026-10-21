package com.communityos.api.billing.application.port;

import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.util.Optional;

/** Billing's narrow view of property: does the unit exist in this community, and which block is it in. */
public interface UnitLookup {
    record UnitRef(UnitId id, BlockId block, String unitNo, boolean active) {}
    Optional<UnitRef> find(UnitId id);
}
