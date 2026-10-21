package com.communityos.api.shared.events;

import com.communityos.api.shared.domain.DomainEvent;
import java.util.List;

/**
 * Publishes an aggregate's events after it is saved: to every in-process handler of that type (Observer - ledger posting, notifications), then
 * to the transactional outbox for the outside world (webhooks, a message broker), in the same database transaction.
 */
public final class DomainEvents {
    private final List<DomainEventHandler<?>> handlers;
    private final OutboxWriter outbox;

    public DomainEvents(List<DomainEventHandler<?>> handlers, OutboxWriter outbox) { this.handlers = List.copyOf(handlers); this.outbox = outbox; }

    @SuppressWarnings("unchecked")
    public void publish(List<DomainEvent> events) {
        for (DomainEvent e : events) {
            for (DomainEventHandler<?> h : handlers) if (h.eventType().isInstance(e)) ((DomainEventHandler<DomainEvent>) h).on(e);
            outbox.append(e);
        }
    }
}
