package com.communityos.port;

import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.domain.ScopeNode;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Optional;

/**
 * PORT: where documents (the JSON records of every collection) are kept. The core never imports a database class.
 * Adapters: JdbcDocumentRepository (PostgreSQL JSONB), InMemoryDocumentRepository. To use MongoDB, DynamoDB or
 * Cosmos DB, write one more class that implements this interface and add it to ProvidersConfig. Nothing else changes.
 *
 * Contract: upsert MERGES the new fields into an existing document (shallow), list keeps insertion order,
 * every call is scoped to one tenant (a community slug, or 'platform').
 */
public interface DocumentRepository {
    List<JsonNode> list(String tenant, String collection);
    Optional<JsonNode> get(String tenant, String collection, String id);
    JsonNode upsert(String tenant, String collection, String id, JsonNode data);
    /** All-or-nothing. Each element needs a text "id". */
    List<JsonNode> upsertAll(String tenant, String collection, List<JsonNode> data);
    boolean delete(String tenant, String collection, String id);
    /** All-or-nothing: remove every document of the collection, then insert these. */
    void replaceAll(String tenant, String collection, List<JsonNode> data);
    PageResult query(String tenant, String collection, QuerySpec spec);
    /**
     * Like {@link #query} but only rows the caller's row scope allows (own unit, own block), filtered by the DATABASE.
     * Only collections that live in a typed table can do this; see {@link #supportsScope}.
     */
    default PageResult queryScoped(String tenant, String collection, QuerySpec spec, ScopeNode scope) {
        if (scope == null || scope instanceof ScopeNode.All) return query(tenant, collection, spec);
        throw new UnsupportedOperationException("Row scope in SQL is not available for " + collection);
    }
    /** Every row the caller's row scope allows (typed tables only; see {@link #supportsScope}). */
    default List<JsonNode> listScoped(String tenant, String collection, ScopeNode scope) {
        if (scope == null || scope instanceof ScopeNode.All) return list(tenant, collection);
        throw new UnsupportedOperationException("Row scope in SQL is not available for " + collection);
    }
    /** One row, only if the caller's row scope allows it. */
    default Optional<JsonNode> getScoped(String tenant, String collection, String id, ScopeNode scope) {
        if (scope == null || scope instanceof ScopeNode.All) return get(tenant, collection, id);
        throw new UnsupportedOperationException("Row scope in SQL is not available for " + collection);
    }
    /**
     * Take a row lock on these records (SELECT ... FOR UPDATE, in id order so two writers never wait on each other in a circle).
     * Only meaningful inside a transaction: the lock is released when it ends. Writers of the same record queue up here, so the
     * version check that follows sees the latest saved version.
     */
    default void lock(String tenant, String collection, java.util.Collection<String> ids) { /* no row locks (in-memory adapter) */ }
    /** The next number for a record's short id (TKT-1058): one counter per community and collection, seeded from the rows already there. */
    long nextShortNumber(String tenant, String collection, long base);
    /** The next audit-trail number (AUD-00042), from a database sequence. */
    long nextAuditNumber();
    /** True when {@link #queryScoped} works for this collection. */
    default boolean supportsScope(String collection) { return false; }
    List<String> tenants();
    void deleteTenant(String tenant);
    /** Cheap "are you alive" check for /health; returns a short name such as "PostgreSQL 16", or throws. */
    String ping();
}
