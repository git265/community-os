package com.communityos.api.maintenance.domain;

import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** Facts the maintenance module publishes (outbox: notifications, integrations). No personal data in the payloads. */
public final class TicketEvents {
    private TicketEvents() {}
    public record TicketRaised(UUID ticketId, CommunityId communityId, UnitId unitId, String category, String priority, String scope, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "maintenance.ticket.raised"; } @Override public UUID aggregateId() { return ticketId; }
    }
    /** previousId: who had it before (told it is no longer theirs), null when it was nobody's. */
    public record TicketAssigned(UUID ticketId, CommunityId communityId, MembershipId assigneeId, MembershipId previousId, String category, Instant occurredAt) implements DomainEvent {
        public TicketAssigned(UUID ticketId, CommunityId communityId, MembershipId assigneeId, String category, Instant occurredAt) { this(ticketId, communityId, assigneeId, null, category, occurredAt); }
        @Override public String topic() { return "maintenance.ticket.assigned"; } @Override public UUID aggregateId() { return ticketId; }
    }
    /** assigneeId: who had the ticket when it moved (a reopen clears it afterwards); joinedUnits: the units that said "me too" on a community request. */
    public record TicketStatusChanged(UUID ticketId, CommunityId communityId, String from, String to, MembershipId assigneeId, List<UUID> joinedUnits, Instant occurredAt) implements DomainEvent {
        public TicketStatusChanged { joinedUnits = joinedUnits == null ? List.of() : List.copyOf(joinedUnits); }
        public TicketStatusChanged(UUID ticketId, CommunityId communityId, String from, String to, Instant occurredAt) { this(ticketId, communityId, from, to, null, List.of(), occurredAt); }
        @Override public String topic() { return "maintenance.ticket.status-changed"; } @Override public UUID aggregateId() { return ticketId; }
    }
    /** The priority or the SLA date changed (null = that one did not). */
    public record TicketTermsChanged(UUID ticketId, CommunityId communityId, MembershipId assigneeId, String priorityFrom, String priorityTo, LocalDate dueFrom, LocalDate dueTo,
                                     Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "maintenance.ticket.terms-changed"; } @Override public UUID aggregateId() { return ticketId; }
    }
    /** A ticket not done by its SLA date (told once per SLA date, by the job). */
    public record TicketOverdue(UUID ticketId, CommunityId communityId, MembershipId assigneeId, LocalDate dueOn, String status, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "maintenance.ticket.overdue"; } @Override public UUID aggregateId() { return ticketId; }
    }
    public record CommentAdded(UUID ticketId, UUID commentId, CommunityId communityId, String visibility, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "maintenance.ticket.commented"; } @Override public UUID aggregateId() { return ticketId; }
    }
}
