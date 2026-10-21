package com.communityos.api.shared.events;

import java.time.Instant;
import java.util.UUID;

/** One row of integration.outbox_event as the relay hands it to a publisher. */
public record OutboxMessage(long id, UUID eventId, UUID communityId, String topic, String aggregateType, UUID aggregateId, String payloadJson, int attempts, Instant createdAt) {}
