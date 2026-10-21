package com.communityos.api.shared.resource;

import java.time.Instant;
import java.util.UUID;

/** One stored row of a resource: the server's columns (id, number, version, times) plus the fields a caller may set. Serialized flat. */
public record Item<F extends Record>(UUID id, String shortId, long version, Instant createdAt, Instant updatedAt, F data, java.util.Map<String, Object> server) {
    public Item(UUID id, String shortId, long version, Instant createdAt, Instant updatedAt, F data) { this(id, shortId, version, createdAt, updatedAt, data, java.util.Map.of()); }
    public Object server(String field) { return server.get(field); }
}
