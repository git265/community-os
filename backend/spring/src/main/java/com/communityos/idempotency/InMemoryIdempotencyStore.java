package com.communityos.idempotency;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

public class InMemoryIdempotencyStore implements IdempotencyStore {
    private record Row(String hash, Instant at, String state, Integer status, String body) {}
    private final Map<String, Row> rows = new HashMap<>();
    private final Clock clock;

    public InMemoryIdempotencyStore(Clock clock) { this.clock = clock; }

    private static String k(String t, String s, String key) { return t + "\u0000" + s + "\u0000" + key; }

    @Override public synchronized boolean begin(String t, String s, String key, String hash) { return rows.putIfAbsent(k(t, s, key), new Row(hash, clock.instant(), "InFlight", null, null)) == null; }
    @Override public synchronized Optional<Entry> find(String t, String s, String key) {
        return Optional.ofNullable(rows.get(k(t, s, key))).map(r -> new Entry(r.hash(), r.state(), r.status(), r.body(), null));
    }
    @Override public synchronized void complete(String t, String s, String key, int status, String body) { rows.computeIfPresent(k(t, s, key), (x, r) -> new Row(r.hash(), r.at(), "Done", status, body)); }
    @Override public synchronized void release(String t, String s, String key) { rows.remove(k(t, s, key)); }
    @Override public synchronized int cleanup(int hours) {
        Instant before = clock.instant().minus(hours, ChronoUnit.HOURS);
        int n = rows.size();
        rows.values().removeIf(r -> r.at().isBefore(before));
        return n - rows.size();
    }
}
