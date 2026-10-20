package com.communityos.outbox;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

/** A row of event_outbox: something that must happen AFTER a change was saved (receipt message, invoice, export to another system). */
public record OutboxEvent(long id, String tenant, String topic, JsonNode payload, int attempts, Instant createdAt) {}
