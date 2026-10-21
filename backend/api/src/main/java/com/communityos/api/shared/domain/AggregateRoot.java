package com.communityos.api.shared.domain;

import java.util.ArrayList;
import java.util.List;

/** Base of an aggregate: the consistency boundary that is loaded and saved as a whole, with its optimistic-lock version and pending events. */
public abstract class AggregateRoot {
    private final List<DomainEvent> events = new ArrayList<>();
    protected long version;

    protected void raise(DomainEvent e) { events.add(e); }
    /** The events raised since the last save; the repository hands them to the event dispatcher and clears them. */
    public List<DomainEvent> pullEvents() { List<DomainEvent> out = List.copyOf(events); events.clear(); return out; }
    public long version() { return version; }
    /** The repository reports the version the database gave the row on save (the stamp_row trigger increments it). */
    public void stored(long newVersion) { this.version = newVersion; }
}
