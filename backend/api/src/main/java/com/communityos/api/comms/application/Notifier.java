package com.communityos.api.comms.application;

import com.communityos.api.comms.application.port.Facts;
import com.communityos.api.comms.application.port.Inbox;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.events.DomainEventHandler;

/**
 * Observer of every domain event: turns what happened into inbox rows (and queued channel messages) in the same transaction as the change,
 * so a notification exists exactly when the thing it reports does. Recipes decide the words and the audience.
 */
public final class Notifier implements DomainEventHandler<DomainEvent> {
    private final Inbox inbox; private final Facts facts;
    public Notifier(Inbox inbox, Facts facts) { this.inbox = inbox; this.facts = facts; }
    @Override public Class<DomainEvent> eventType() { return DomainEvent.class; }
    @Override public void on(DomainEvent e) {
        for (Comms.Message m : Recipes.of(e, facts)) if (!m.to().empty()) inbox.deliver(m);
    }
}
