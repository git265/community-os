package com.communityos.api.amenity.domain;

import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.Ids.CommunityId;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/** What the amenities module publishes (notifications, reports, integrations). No personal data. */
public record BookingEvents(String topic, UUID aggregateId, CommunityId communityId, UUID amenityTypeId, LocalDate date, String status, String paymentStatus, Instant occurredAt)
    implements DomainEvent {}
