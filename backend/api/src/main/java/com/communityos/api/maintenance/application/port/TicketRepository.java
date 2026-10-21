package com.communityos.api.maintenance.application.port;

import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.util.Optional;
import java.util.UUID;

public interface TicketRepository {
    record Filter(String status, boolean activeOnly, String category, UnitId unit, MembershipId raisedBy, MembershipId assignee, String q) {}
    Page<Ticket> find(Spec<Ticket> scope, Filter filter, PageQuery page);
    Optional<Ticket> findById(UUID id, Spec<Ticket> scope);
    /** Inserts and numbers it (TKT-1051 ...). */
    void insert(Ticket t);
    /** false when the version no longer matches. */
    boolean save(Ticket t);
}
