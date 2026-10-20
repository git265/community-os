package com.communityos.adapter.persistence;

import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.port.DocumentRepository;
import com.communityos.web.Names;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

/**
 * PostgreSQL adapter: one `documents` table, record = JSONB (db/V1__documents.sql). Every name reaches SQL only as a bind
 * parameter. The same SQL runs in backend/contract-server/server.mjs and is checked against the UI's query engine.
 */
public class JdbcDocumentRepository implements DocumentRepository {
    private static final String UPSERT = """
            INSERT INTO documents (tenant, collection, id, data, updated_at) VALUES (?, ?, ?, CAST(? AS jsonb), now())
            ON CONFLICT (tenant, collection, id) DO UPDATE SET data = documents.data || EXCLUDED.data, updated_at = now()
            RETURNING data::text""";

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    private final ShortIdCounters counters;

    public JdbcDocumentRepository(JdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; this.counters = new ShortIdCounters(jdbc); }

    @Override public void lock(String tenant, String collection, java.util.Collection<String> ids) {
        for (String id : new java.util.TreeSet<>(ids))
            jdbc.queryForList("SELECT 1 FROM documents WHERE tenant = ? AND collection = ? AND id = ? FOR UPDATE", tenant, collection, id);
    }

    @Override public long nextShortNumber(String tenant, String collection, long base) {
        return counters.next(tenant, collection, base, ShortIdCounters.maxSql("documents", true), tenant, collection);
    }

    @Override public long nextAuditNumber() { return counters.nextAudit(); }

    private JsonNode parse(String s) {
        try { return json.readTree(s); } catch (JsonProcessingException e) { throw new IllegalStateException(e); }
    }

    @Override public List<JsonNode> list(String tenant, String collection) {
        return jdbc.query("SELECT data::text FROM documents WHERE tenant = ? AND collection = ? ORDER BY seq",
                (rs, i) -> parse(rs.getString(1)), tenant, collection);
    }

    @Override public Optional<JsonNode> get(String tenant, String collection, String id) {
        return jdbc.query("SELECT data::text FROM documents WHERE tenant = ? AND collection = ? AND id = ?",
                (rs, i) -> parse(rs.getString(1)), tenant, collection, id).stream().findFirst();
    }

    @Override public JsonNode upsert(String tenant, String collection, String id, JsonNode data) {
        return parse(jdbc.queryForObject(UPSERT, String.class, tenant, collection, id, data.toString()));
    }

    @Override @Transactional(rollbackFor = Exception.class) public List<JsonNode> upsertAll(String tenant, String collection, List<JsonNode> data) {
        List<JsonNode> out = new ArrayList<>(data.size());
        for (JsonNode d : data) out.add(upsert(tenant, collection, d.path("id").asText(), d));
        return out;
    }

    @Override public boolean delete(String tenant, String collection, String id) {
        return jdbc.update("DELETE FROM documents WHERE tenant = ? AND collection = ? AND id = ?", tenant, collection, id) > 0;
    }

    @Override @Transactional(rollbackFor = Exception.class) public void replaceAll(String tenant, String collection, List<JsonNode> data) {
        jdbc.update("DELETE FROM documents WHERE tenant = ? AND collection = ?", tenant, collection);
        upsertAll(tenant, collection, data);
    }

    @Override public List<String> tenants() { return jdbc.queryForList("SELECT DISTINCT tenant FROM documents", String.class); }

    @Override public void deleteTenant(String tenant) { jdbc.update("DELETE FROM documents WHERE tenant = ?", tenant); }

    @Override public String ping() {
        return jdbc.queryForObject("SELECT 'PostgreSQL'", String.class);
    }

    // ---- query -------------------------------------------------------------------------------------------------
    private static String like(String s) { return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"; }

    @Override public PageResult query(String tenant, String collection, QuerySpec q) {
        StringBuilder where = new StringBuilder("tenant = ? AND collection = ?");
        List<Object> args = new ArrayList<>(List.of(tenant, collection));

        for (Map.Entry<String, List<String>> f : q.filters().entrySet()) {
            Names.key(f.getKey());
            if (f.getValue().contains("__none__")) { where.append(" AND COALESCE(data->>?, '') = ''"); args.add(f.getKey()); }
            else if (!f.getValue().isEmpty()) {
                where.append(" AND COALESCE(data->>?, '') = ANY(?)");
                args.add(f.getKey());
                args.add(f.getValue().toArray(new String[0])); // JdbcTemplate maps String[] to a PostgreSQL text[]
            }
        }
        if (notBlank(q.dateKey()) && (notBlank(q.from()) || notBlank(q.to()))) {
            Names.key(q.dateKey());
            if (notBlank(q.from())) { where.append(" AND left(data->>?, 10) >= ?"); args.add(q.dateKey()); args.add(q.from()); }
            if (notBlank(q.to())) { where.append(" AND left(data->>?, 10) <= ?"); args.add(q.dateKey()); args.add(q.to()); }
        }
        if (notBlank(q.periodKey()) && (notBlank(q.year()) || notBlank(q.month()))) {
            Names.key(q.periodKey());
            if (notBlank(q.year())) { where.append(" AND split_part(data->>?, '-', 1) = ?"); args.add(q.periodKey()); args.add(q.year()); }
            if (notBlank(q.month())) { where.append(" AND split_part(data->>?, '-', 2) = ?"); args.add(q.periodKey()); args.add(q.month()); }
        }
        if (notBlank(q.search())) {
            String pattern = like(q.search());
            if (!q.searchKeys().isEmpty()) {
                List<String> ors = new ArrayList<>();
                for (String k : q.searchKeys()) { Names.key(k); ors.add("data->>? ILIKE ?"); args.add(k); args.add(pattern); }
                where.append(" AND (").append(String.join(" OR ", ors)).append(")");
            } else {
                where.append(" AND EXISTS (SELECT 1 FROM jsonb_each_text(data) e WHERE jsonb_typeof(data->e.key) NOT IN ('object','array') AND e.value ILIKE ?)");
                args.add(pattern);
            }
        }
        Long total = jdbc.queryForObject("SELECT count(*) FROM documents WHERE " + where, Long.class, args.toArray());

        String order = " ORDER BY seq";
        List<Object> pageArgs = new ArrayList<>(args);
        if (notBlank(q.sortKey())) {
            Names.key(q.sortKey());
            String dir = "desc".equalsIgnoreCase(q.sortDir()) ? "DESC" : "ASC";
            String v = "(data->>?)";
            // numbers sort as numbers (before text); text sorts as text - the same rule as the browser comparator
            order = " ORDER BY (CASE WHEN " + v + " ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 0 ELSE 1 END) " + dir
                    + ", (CASE WHEN " + v + " ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN " + v + "::numeric END) " + dir
                    + ", " + v + " " + dir + ", seq";
            for (int i = 0; i < 4; i++) pageArgs.add(q.sortKey()); // the key appears four times in the ORDER BY
        }
        int size = Math.min(1000, Math.max(1, q.pageSize()));
        long t = total == null ? 0 : total;
        int pages = (int) Math.max(1, Math.ceil(t / (double) size));
        int page = Math.min(Math.max(1, q.page()), pages);
        List<JsonNode> rows = jdbc.query("SELECT data::text FROM documents WHERE " + where + order + " LIMIT " + size + " OFFSET " + ((long) (page - 1) * size),
                (rs, i) -> parse(rs.getString(1)), pageArgs.toArray());
        return new PageResult(rows, t, page, size, pages);
    }

    private static boolean notBlank(String s) { return s != null && !s.isBlank(); }
}
