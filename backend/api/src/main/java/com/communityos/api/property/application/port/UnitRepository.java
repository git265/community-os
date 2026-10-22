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
    /** `q`: a unit number, or the name / phone of anyone living there; `type`: Villa, Apartment ...; `noBlock`: only the units in no block. */
    record Filter(String q, BlockId block, String occupancy, boolean includeArchived, String type, boolean noBlock) {
        public Filter(String q, BlockId block, String occupancy, boolean includeArchived) { this(q, block, occupancy, includeArchived, null, false); }
    }
    /** How many homes a block has, and how they are lived in (the directory's block list). `block` null: the units in no block. */
    record BlockCount(java.util.UUID block, String name, long total, long ownerOccupied, long tenantOccupied, long vacant) {}
    default java.util.List<BlockCount> countByBlock(Spec<Unit> scope) { return java.util.List.of(); }
    /** A unit's number and block, for every unit (archived too) - what the app needs to name the units other records point at. */
    record Entry(java.util.UUID id, String unitNo, java.util.UUID blockId, String blockName) {}
    default java.util.List<Entry> index(Spec<Unit> scope) { return java.util.List.of(); }
    Page<Unit> find(Spec<Unit> scope, Filter filter, PageQuery page);
    Optional<Unit> findById(UnitId id, Spec<Unit> scope);
    /** false when the version no longer matches. */
    boolean save(Unit unit, long expectedVersion);
    Set<String> propertyTypes();
}
