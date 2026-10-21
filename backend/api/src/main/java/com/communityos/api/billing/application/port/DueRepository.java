package com.communityos.api.billing.application.port;

import com.communityos.api.billing.domain.Due;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface DueRepository {
    record Filter(UnitId unit, String status, LocalDate monthFrom, LocalDate monthTo, String categoryCode, boolean openOnly) {}
    Page<Due> find(Spec<Due> scope, Filter filter, PageQuery page);
    Optional<Due> findById(DueId id, Spec<Due> scope);
    /** Row-locks the bills (FOR UPDATE, in id order so two payments never deadlock), oldest due date first. */
    List<Due> lockForSettlement(Collection<DueId> ids);
    /** The open bills of a unit, locked, oldest due date first (a payment with no bills named pays the oldest). */
    List<Due> lockOpenOfUnit(UnitId unit);
    /** Inserts and numbers it (DUE-0001). */
    void insert(Due due);
    /** false when the version no longer matches. */
    boolean save(Due due);
}
