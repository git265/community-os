package com.communityos.adapter.persistence.typed;

import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.domain.ScopeNode;
import com.communityos.web.BadRequestException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Reads and writes the collections that have a real table (units, users, dues, bookings, tickets, ledger, audit trail).
 * The record stays ONE JSON document in `data`; the typed columns are GENERATED from it by PostgreSQL (so they cannot
 * disagree with it), except the audit table, which is partitioned by month and is filled by this class.
 * Not used directly: {@link RoutingDocumentRepository} sends a collection here or to the generic JSONB table.
 * It starts no transactions of its own (it is not a Spring bean, so an annotation here would do nothing): the service that knows the whole
 * unit of work wraps it in com.communityos.service.Tx.
 */
public class TypedDocumentRepository {
    private static final Logger log = LoggerFactory.getLogger(TypedDocumentRepository.class);
    private static final int MAX_PAGE = 1000;
    /** Counting stops here, so a huge table never costs a full count; `PageResult.total` is then a floor. */
    static final int COUNT_CAP = 100_000;

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public TypedDocumentRepository(JdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    private JsonNode parse(String s) {
        try { return json.readTree(s); } catch (JsonProcessingException e) { throw new IllegalStateException(e); }
    }

    public List<JsonNode> list(CollectionMapping m, String tenant) {
        return jdbc.query("SELECT data::text FROM " + m.table() + " WHERE tenant = ? " + (m.appendOnly() ? "ORDER BY at, seq" : "ORDER BY seq"),
                (rs, i) -> parse(rs.getString(1)), tenant);
    }

    public Optional<JsonNode> get(CollectionMapping m, String tenant, String id) {
        return jdbc.query("SELECT data::text FROM " + m.table() + " WHERE tenant = ? AND id = ? LIMIT 1",
                (rs, i) -> parse(rs.getString(1)), tenant, id).stream().findFirst();
    }

    public JsonNode upsert(CollectionMapping m, String tenant, String id, JsonNode data) {
        try {
            if (m.appendOnly()) return insertAudit(m, tenant, id, data);
            String sql = "INSERT INTO " + m.table() + " (tenant, id, data, updated_at) VALUES (?, ?, CAST(? AS jsonb), now()) "
                    + "ON CONFLICT (tenant, id) DO UPDATE SET data = " + m.table() + ".data || EXCLUDED.data, updated_at = now() RETURNING data::text";
            return parse(jdbc.queryForObject(sql, String.class, tenant, id, data.toString()));
        } catch (DataIntegrityViolationException e) {
            throw explain(m, e);
        }
    }

    /** The audit trail is insert-only; a repeated id at the same instant is ignored (a retried request does not log twice). */
    private JsonNode insertAudit(CollectionMapping m, String tenant, String id, JsonNode d) {
        Instant at = instant(d.path("when").asText(""));
        String sql = "INSERT INTO audit_log (tenant, id, at, short_id, who, who_name, action, collection, record_id, record_short_id, unit, summary, ip, request_id, data) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CAST(? AS jsonb)) ON CONFLICT (tenant, at, id) DO NOTHING";
        jdbc.update(sql, tenant, id, Timestamp.from(at), s(d, "shortId"), s(d, "who"), s(d, "whoName"), s(d, "action"), s(d, "collection"),
                s(d, "recordId"), s(d, "recordShortId"), s(d, "unit"), cut(s(d, "summary"), 2000), s(d, "ip"), s(d, "requestId"), d.toString());
        return d;
    }

    private static Instant instant(String when) {
        try { return when.isBlank() ? Instant.now() : Instant.parse(when); } catch (RuntimeException e) { return Instant.now(); }
    }
    private static String s(JsonNode d, String k) { String v = d.path(k).asText(""); return v.isEmpty() ? null : v; }
    private static String cut(String v, int n) { return v != null && v.length() > n ? v.substring(0, n) : v; }

    public List<JsonNode> upsertAll(CollectionMapping m, String tenant, List<JsonNode> data) {
        List<JsonNode> out = new ArrayList<>(data.size());
        for (JsonNode d : data) out.add(upsert(m, tenant, d.path("id").asText(), d));
        return out;
    }

    public boolean delete(CollectionMapping m, String tenant, String id) {
        refuseIfAppendOnly(m);
        try { return jdbc.update("DELETE FROM " + m.table() + " WHERE tenant = ? AND id = ?", tenant, id) > 0; }
        catch (DataIntegrityViolationException e) { throw explain(m, e); }
    }

    public void replaceAll(CollectionMapping m, String tenant, List<JsonNode> data) {
        refuseIfAppendOnly(m);
        try { jdbc.update("DELETE FROM " + m.table() + " WHERE tenant = ?", tenant); }
        catch (DataIntegrityViolationException e) { throw explain(m, e); }
        upsertAll(m, tenant, data);
    }

    /** Admin reset of a community: every typed table. */
    public void deleteTenant(String tenant) {
        for (String t : new String[]{"dues", "bookings", "tickets", "ledger_entries", "users", "units", "audit_log"})
            jdbc.update("DELETE FROM " + t + " WHERE tenant = ?", tenant);
    }

    public List<String> tenants() {
        return jdbc.queryForList("SELECT DISTINCT tenant FROM users", String.class);
    }

    /** Every row the scope allows, in insertion order (the SQL form of the caller's row rule). */
    public List<JsonNode> listScoped(CollectionMapping m, String tenant, ScopeNode scope) {
        QueryCompiler.Compiled c = QueryCompiler.compile(m, tenant, ALL_ROWS, scope);
        return jdbc.query("SELECT data::text FROM " + m.table() + " WHERE " + c.where() + " ORDER BY " + (m.appendOnly() ? "at, seq" : "seq"),
                (rs, i) -> parse(rs.getString(1)), c.whereArgs().toArray());
    }

    public Optional<JsonNode> getScoped(CollectionMapping m, String tenant, String id, ScopeNode scope) {
        QueryCompiler.Compiled c = QueryCompiler.compile(m, tenant, ALL_ROWS, scope);
        List<Object> args = new ArrayList<>(c.whereArgs());
        args.add(id);
        return jdbc.query("SELECT data::text FROM " + m.table() + " WHERE " + c.where() + " AND id = ? LIMIT 1", (rs, i) -> parse(rs.getString(1)), args.toArray()).stream().findFirst();
    }

    /** Row locks, in id order. Call inside a transaction. */
    public void lock(CollectionMapping m, String tenant, java.util.Collection<String> ids) {
        for (String id : new java.util.TreeSet<>(ids))
            jdbc.queryForList("SELECT 1 FROM " + m.table() + " WHERE tenant = ? AND id = ? FOR UPDATE", tenant, id);
    }

    private static final QuerySpec ALL_ROWS = new QuerySpec(1, 1000, "", "asc", "", List.of(), "", "", "", "", "", "", java.util.Map.of());

    public PageResult page(CollectionMapping m, String tenant, QuerySpec spec, ScopeNode scope) {
        QueryCompiler.Compiled c = QueryCompiler.compile(m, tenant, spec, scope);
        long counted = jdbc.queryForObject("SELECT count(*) FROM (SELECT 1 FROM " + m.table() + " WHERE " + c.where() + " LIMIT " + (COUNT_CAP + 1) + ") s",
                Long.class, c.whereArgs().toArray());
        boolean approx = counted > COUNT_CAP;
        long total = Math.min(counted, COUNT_CAP);
        int size = Math.min(MAX_PAGE, Math.max(1, spec.pageSize()));
        int pages = (int) Math.max(1, Math.ceil(total / (double) size));
        int page = Math.min(Math.max(1, spec.page()), pages);
        List<JsonNode> rows = jdbc.query("SELECT data::text FROM " + m.table() + " WHERE " + c.where() + c.order() + " LIMIT " + size + " OFFSET " + ((long) (page - 1) * size),
                (rs, i) -> parse(rs.getString(1)), c.pageArgs().toArray());
        log.debug("page {} tenant={} rows={} total={} scoped={}", m.table(), tenant, rows.size(), total, scope != null && !(scope instanceof ScopeNode.All));
        return new PageResult(rows, total, page, size, pages, approx);
    }

    private static void refuseIfAppendOnly(CollectionMapping m) {
        if (m.appendOnly()) throw new org.springframework.security.access.AccessDeniedException("The audit trail cannot be deleted.");
    }

    /** Turns a constraint failure into a message the person can act on (400 / 409 through ApiExceptionHandler). */
    private RuntimeException explain(CollectionMapping m, DataIntegrityViolationException e) {
        String msg = String.valueOf(e.getMostSpecificCause().getMessage());
        if (msg.contains("foreign key") && msg.contains("violates")) {
            if (msg.contains("update or delete")) return new BadRequestException("This " + m.table() + " record is still used by other records and cannot be removed.");
            return new BadRequestException("That unit does not exist. Add the unit first.");
        }
        if (msg.contains("duplicate key")) return new BadRequestException("A record with the same unique value already exists.");
        log.warn("constraint failure on {}: {}", m.table(), msg);
        return e;
    }
}
