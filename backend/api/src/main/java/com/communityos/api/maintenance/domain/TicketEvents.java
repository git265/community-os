package com.communityos.api.maintenance.domain;

import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.time.Instant;
import java.util.UUID;

/** Facts the maintenance module publishes (outbox: notifications, integrations). No personal data in the payloads. */
public final class TicketEvents {
    private TicketEvents() {}
    public record TicketRaised(UUID ticketId, CommunityId communityId, UnitId unitId, String category, String priority, String scope, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "maintenance.ticket.raised"; } @Override public UUID aggregateId() { return ticketId; }
    }
    public record TicketAssigned(UUID ticketId, CommunityId communityId, MembershipId assigneeId, String category, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "maintenance.ticket.assigned"; } @Override public UUID aggregateId() { return ticketId; }
    }
    public record TicketStatusChanged(UUID ticketId, CommunityId communityId, String from, String to, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "maintenance.ticket.status-changed"; } @Override public UUID aggregateId() { return ticketId; }
    }
    public record CommentAdded(UUID ticketId, UUID commentId, CommunityId communityId, String visibility, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "maintenance.ticket.commented"; } @Override public UUID aggregateId() { return ticketId; }
    }
}
