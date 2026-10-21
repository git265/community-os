package com.communityos.api.property.application.port;

import com.communityos.api.property.domain.Unit;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.util.Optional;
import java.util.Set;

public interface UnitRepository {
    record Filter(String q, BlockId block, String occupancy, boolean includeArchived) {}
    Page<Unit> find(Spec<Unit> scope, Filter filter, PageQuery page);
    Optional<Unit> findById(UnitId id, Spec<Unit> scope);
    /** false when the version no longer matches. */
    boolean save(Unit unit, long expectedVersion);
    Set<String> propertyTypes();
}
