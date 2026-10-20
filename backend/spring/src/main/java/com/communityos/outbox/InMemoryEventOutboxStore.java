package com.communityos.outbox;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** For the `memory` profile and tests. */
public class InMemoryEventOutboxStore implements EventOutboxStore {
    private static final class Row {
        final OutboxEvent ev; String status = "Pending"; int attempts; Instant next; String error;
        Row(OutboxEvent ev, Instant next) { this.ev = ev; this.next = next; }
    }
    private final Map<Long, Row> rows = new TreeMap<>();
    private long seq;
    private final Clock clock;

    public InMemoryEventOutboxStore(Clock clock) { this.clock = clock; }

    @Override public synchronized void emit(String tenant, String topic, JsonNode payload) {
        long id = ++seq;
        rows.put(id, new Row(new OutboxEvent(id, tenant, topic, payload, 0, clock.instant()), clock.instant()));
    }
    @Override public synchronized List<OutboxEvent> lockDue(int limit) {
        List<OutboxEvent> out = new ArrayList<>();
        for (Row r : rows.values()) {
            if (out.size() >= limit) break;
            if ("Pending".equals(r.status) && !r.next.isAfter(clock.instant())) out.add(new OutboxEvent(r.ev.id(), r.ev.tenant(), r.ev.topic(), r.ev.payload(), r.attempts, r.ev.createdAt()));
        }
        return out;
    }
    @Override public synchronized void markSent(long id) { Row r = rows.get(id); r.status = "Sent"; r.attempts++; r.error = null; }
    @Override public synchronized void markRetry(long id, int attempts, String error, long delaySeconds) {
        Row r = rows.get(id); r.attempts = attempts; r.error = error; r.next = clock.instant().plusSeconds(delaySeconds);
    }
    @Override public synchronized void markDead(long id, int attempts, String error) { Row r = rows.get(id); r.status = "Dead"; r.attempts = attempts; r.error = error; }
    @Override public synchronized Map<String, Long> counts() {
        Map<String, Long> out = new LinkedHashMap<>();
        rows.values().forEach(r -> out.merge(r.status, 1L, Long::sum));
        return out;
    }
    /** Test peek. */
    public synchronized String statusOf(long id) { return rows.get(id).status; }
    public synchronized String errorOf(long id) { return rows.get(id).error; }
}
