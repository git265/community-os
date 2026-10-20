package com.communityos.adapter.persistence;

import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.port.DocumentRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/** No-database adapter (profile `memory`): for UI work and tests. Same contract as the PostgreSQL adapter. */
public class InMemoryDocumentRepository implements DocumentRepository {
    private final Map<String, Map<String, JsonNode>> store = new ConcurrentHashMap<>();

    private Map<String, JsonNode> bucket(String tenant, String collection) {
        return store.computeIfAbsent(tenant + "\u0000" + collection, k -> java.util.Collections.synchronizedMap(new LinkedHashMap<>()));
    }

    @Override public List<JsonNode> list(String t, String c) { synchronized (bucket(t, c)) { return new ArrayList<>(bucket(t, c).values()); } }
    @Override public Optional<JsonNode> get(String t, String c, String id) { return Optional.ofNullable(bucket(t, c).get(id)); }

    @Override public JsonNode upsert(String t, String c, String id, JsonNode data) {
        Map<String, JsonNode> b = bucket(t, c);
        synchronized (b) {
            JsonNode old = b.get(id);
            ObjectNode merged = old instanceof ObjectNode o ? o.deepCopy() : ((ObjectNode) data).objectNode();
            merged.setAll((ObjectNode) data); // shallow merge, like `data || new` in PostgreSQL
            b.put(id, merged);
            return merged;
        }
    }

    @Override public synchronized List<JsonNode> upsertAll(String t, String c, List<JsonNode> data) {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode d : data) out.add(upsert(t, c, d.path("id").asText(), d));
        return out;
    }

    @Override public boolean delete(String t, String c, String id) { return bucket(t, c).remove(id) != null; }
    @Override public synchronized void replaceAll(String t, String c, List<JsonNode> data) { bucket(t, c).clear(); upsertAll(t, c, data); }
    @Override public List<String> tenants() { return store.keySet().stream().map(k -> k.substring(0, k.indexOf('\u0000'))).distinct().toList(); }
    @Override public void deleteTenant(String tenant) { store.keySet().removeIf(k -> k.startsWith(tenant + "\u0000")); }
    @Override public String ping() { return "in-memory"; }

    private final Map<String, java.util.concurrent.atomic.AtomicLong> counters = new ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicLong audit = new java.util.concurrent.atomic.AtomicLong();

    @Override public long nextShortNumber(String t, String c, long base) {
        return counters.computeIfAbsent(t + "\u0000" + c, k -> new java.util.concurrent.atomic.AtomicLong(Math.max(base, highest(t, c)))).incrementAndGet();
    }
    private long highest(String t, String c) {
        long max = 0;
        for (JsonNode r : list(t, c)) {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("^[A-Za-z]+-([0-9]+)$").matcher(r.path("shortId").asText(""));
            if (m.matches()) max = Math.max(max, Long.parseLong(m.group(1)));
        }
        return max;
    }
    @Override public long nextAuditNumber() { return audit.incrementAndGet(); }

    @Override public PageResult query(String t, String c, QuerySpec q) { return RowQuery.run(list(t, c), q); }
}
