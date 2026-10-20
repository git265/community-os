package com.communityos.outbox;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** PORT: the event_outbox table (db/V4). `emit` must run in the SAME transaction as the change it announces. */
public interface EventOutboxStore {
    void emit(String tenant, String topic, JsonNode payload);
    /** Pending events that are due, oldest first. In a transaction on PostgreSQL the rows are locked with SKIP LOCKED: two workers never take the same one. */
    List<OutboxEvent> lockDue(int limit);
    void markSent(long id);
    void markRetry(long id, int attempts, String error, long delaySeconds);
    void markDead(long id, int attempts, String error);
    /** Counts by status, for /health and the admin screen. */
    java.util.Map<String, Long> counts();
}
