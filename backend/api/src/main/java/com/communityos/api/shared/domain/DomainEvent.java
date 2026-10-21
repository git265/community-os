package com.communityos.api.shared.domain;

import java.time.Instant;
import java.util.UUID;

/** Something that happened in the domain. Handled in-process in the same transaction (Observer) and written to the outbox for the outside world. */
public interface DomainEvent {
    /** dotted topic: billing.due.paid */
    String topic();
    UUID aggregateId();
    Ids.CommunityId communityId();
    Instant occurredAt();
}
