package com.communityos.api.shared.events;

import com.communityos.api.shared.domain.DomainEvent;

/** Observer: reacts to one kind of domain event, in the same transaction as the change that raised it (so both commit or neither does). */
public interface DomainEventHandler<E extends DomainEvent> {
    Class<E> eventType();
    void on(E event);
}
