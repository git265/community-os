package com.communityos.api.shared.events;

import com.communityos.api.shared.domain.DomainEvent;

/** Port: writes an event to integration.outbox_event in the current transaction. A relay delivers it afterwards (at-least-once). */
public interface OutboxWriter {
    void append(DomainEvent event);
}
