package com.communityos.adapter.persistence.typed;

import com.communityos.adapter.persistence.JdbcDocumentRepository;
import com.communityos.adapter.persistence.ShortIdCounters;
import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.domain.ScopeNode;
import com.communityos.port.DocumentRepository;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * THE router. It is the one class that decides where a collection lives: a typed table ({@link CollectionMappings}) or the
 * generic JSONB `documents` table. Controllers, services and the UI never know. Same job as the Node server's store/repository.mjs.
 */
public class RoutingDocumentRepository implements DocumentRepository {
    private static final Logger log = LoggerFactory.getLogger(RoutingDocumentRepository.class);

    private final DocumentRepository generic;           // JSONB documents
    private final TypedDocumentRepository typed;        // real tables
    private final ShortIdCounters counters;

    public RoutingDocumentRepository(DocumentRepository generic, TypedDocumentRepository typed, ShortIdCounters counters) {
        this.generic = generic; this.typed = typed; this.counters = counters;
        log.info("Storage routing: typed tables for {}; everything else in the documents table", "properties, users, dues, amenities, tickets, ledger, audit");
    }

    private Optional<CollectionMapping> route(String collection) { return CollectionMappings.of(collection); }

    @Override public List<JsonNode> list(String t, String c) { return route(c).map(m -> typed.list(m, t)).orElseGet(() -> generic.list(t, c)); }
    @Override public Optional<JsonNode> get(String t, String c, String id) { Optional<CollectionMapping> m = route(c); return m.isPresent() ? typed.get(m.get(), t, id) : generic.get(t, c, id); }
    @Override public JsonNode upsert(String t, String c, String id, JsonNode d) { Optional<CollectionMapping> m = route(c); return m.isPresent() ? typed.upsert(m.get(), t, id, d) : generic.upsert(t, c, id, d); }
    @Override public List<JsonNode> upsertAll(String t, String c, List<JsonNode> d) { Optional<CollectionMapping> m = route(c); return m.isPresent() ? typed.upsertAll(m.get(), t, d) : generic.upsertAll(t, c, d); }
    @Override public boolean delete(String t, String c, String id) { Optional<CollectionMapping> m = route(c); return m.isPresent() ? typed.delete(m.get(), t, id) : generic.delete(t, c, id); }
    @Override public void replaceAll(String t, String c, List<JsonNode> d) {
        Optional<CollectionMapping> m = route(c);
        if (m.isPresent()) typed.replaceAll(m.get(), t, d); else generic.replaceAll(t, c, d);
    }
    @Override public PageResult query(String t, String c, QuerySpec s) { return queryScoped(t, c, s, null); }

    @Override public PageResult queryScoped(String t, String c, QuerySpec s, ScopeNode scope) {
        Optional<CollectionMapping> m = route(c);
        if (m.isPresent()) return typed.page(m.get(), t, s, scope);
        if (scope != null && !(scope instanceof ScopeNode.All)) throw new UnsupportedOperationException("Row scope in SQL is not available for " + c);
        return generic.query(t, c, s);
    }
    @Override public List<JsonNode> listScoped(String t, String c, ScopeNode scope) {
        Optional<CollectionMapping> m = route(c);
        if (m.isPresent()) return typed.listScoped(m.get(), t, scope);
        if (scope != null && !(scope instanceof ScopeNode.All)) throw new UnsupportedOperationException("Row scope in SQL is not available for " + c);
        return generic.list(t, c);
    }
    @Override public Optional<JsonNode> getScoped(String t, String c, String id, ScopeNode scope) {
        Optional<CollectionMapping> m = route(c);
        if (m.isPresent()) return typed.getScoped(m.get(), t, id, scope);
        if (scope != null && !(scope instanceof ScopeNode.All)) throw new UnsupportedOperationException("Row scope in SQL is not available for " + c);
        return generic.get(t, c, id);
    }
    @Override public void lock(String t, String c, java.util.Collection<String> ids) {
        Optional<CollectionMapping> m = route(c);
        if (m.isPresent()) typed.lock(m.get(), t, ids); else generic.lock(t, c, ids);
    }
    @Override public long nextShortNumber(String t, String c, long base) {
        Optional<CollectionMapping> m = route(c);
        return m.isPresent() ? counters.next(t, c, base, ShortIdCounters.maxSql(m.get().table(), false), t)
                : generic.nextShortNumber(t, c, base);
    }
    @Override public long nextAuditNumber() { return counters.nextAudit(); }
    @Override public boolean supportsScope(String c) { return CollectionMappings.isTyped(c); }

    @Override public List<String> tenants() {
        Set<String> all = new LinkedHashSet<>(generic.tenants());
        all.addAll(typed.tenants());
        return new ArrayList<>(all);
    }
    @Override public void deleteTenant(String t) { typed.deleteTenant(t); generic.deleteTenant(t); }
    @Override public String ping() { return generic.ping(); }
}
