package com.communityos.adapter.persistence.typed;

import com.communityos.domain.QuerySpec;
import com.communityos.domain.ScopeNode;
import com.communityos.web.Names;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * QuerySpec + row scope -> SQL for ONE typed table. Same behaviour as backend/contract-server/store/sqlquery.mjs.
 * Values are always bind parameters; field names are validated ({@link Names#key}) and either mapped to a column or bound.
 */
final class QueryCompiler {
    private QueryCompiler() {}

    /** @param where WHERE text; @param whereArgs its binds (also used by the count); @param order ORDER BY text; @param orderArgs its binds */
    record Compiled(String where, List<Object> whereArgs, String order, List<Object> orderArgs) {
        List<Object> pageArgs() { List<Object> all = new ArrayList<>(whereArgs); all.addAll(orderArgs); return all; }
    }

    private static String like(String s) { return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"; }
    private static boolean notBlank(String s) { return s != null && !s.isBlank(); }

    static Compiled compile(CollectionMapping m, String tenant, QuerySpec q, ScopeNode scope) {
        SqlBuilder b = new SqlBuilder(m);
        b.and("tenant = " + b.arg(tenant));
        if (scope != null) b.and(ScopeSql.toSql(scope, b));

        for (Map.Entry<String, List<String>> f : q.filters().entrySet()) {
            List<String> vals = f.getValue();
            if (vals == null || vals.isEmpty()) continue;
            if (vals.contains("__none__")) { b.and("COALESCE(" + b.text(f.getKey()) + ", '') = ''"); continue; }
            String expr = b.hasColumn(f.getKey()) && !vals.contains("") ? b.text(f.getKey()) : "COALESCE(" + b.text(f.getKey()) + ", '')";
            b.and(expr + " = ANY(" + b.arg(vals.toArray(new String[0])) + ")");
        }
        if (notBlank(q.dateKey()) && (notBlank(q.from()) || notBlank(q.to()))) {
            String col = m.sortColumn(q.dateKey());
            if (col != null && CollectionMappings.DATE_COLUMNS.contains(col)) {
                if (notBlank(q.from())) b.and(col + " >= CAST(" + b.arg(q.from()) + " AS date)");
                if (notBlank(q.to())) b.and(col + " <= CAST(" + b.arg(q.to()) + " AS date)");
            } else {
                if (notBlank(q.from())) b.and("left(" + json(b, q.dateKey()) + ", 10) >= " + b.arg(q.from()));
                if (notBlank(q.to())) b.and("left(" + json(b, q.dateKey()) + ", 10) <= " + b.arg(q.to()));
            }
        }
        if (notBlank(q.periodKey()) && (notBlank(q.year()) || notBlank(q.month()))) {
            if (notBlank(q.year())) b.and("split_part(" + json(b, q.periodKey()) + ", '-', 1) = " + b.arg(q.year()));
            if (notBlank(q.month())) b.and("split_part(" + json(b, q.periodKey()) + ", '-', 2) = " + b.arg(q.month()));
        }
        if (notBlank(q.search())) {
            String pattern = like(q.search());
            if (q.searchKeys() != null && !q.searchKeys().isEmpty()) {
                List<String> ors = new ArrayList<>();
                for (String k : q.searchKeys()) ors.add(b.text(k) + " ILIKE " + b.arg(pattern));
                b.and("(" + String.join(" OR ", ors) + ")");
            } else {
                b.and("EXISTS (SELECT 1 FROM jsonb_each_text(data) e WHERE jsonb_typeof(data->e.key) NOT IN ('object','array') AND e.value ILIKE " + b.arg(pattern) + ")");
            }
        }
        String where = b.whereClause();
        List<Object> whereArgs = new ArrayList<>(b.args());

        // ---- order: a typed column when there is one; otherwise numbers-as-numbers then text, like the browser comparator ----
        SqlBuilder o = new SqlBuilder(m);
        String order = m.appendOnly() ? " ORDER BY at, seq" : " ORDER BY seq";
        if (notBlank(q.sortKey())) {
            String dir = "desc".equalsIgnoreCase(q.sortDir()) ? "DESC" : "ASC";
            String col = m.sortColumn(q.sortKey());
            if (col != null) order = " ORDER BY " + col + " " + dir + " NULLS LAST, seq";   // ties keep their original order
            else {
                String num = "'^-?[0-9]+(\\.[0-9]+)?$'";
                order = " ORDER BY (CASE WHEN " + json(o, q.sortKey()) + " ~ " + num + " THEN 0 ELSE 1 END) " + dir
                      + ", (CASE WHEN " + json(o, q.sortKey()) + " ~ " + num + " THEN CAST(" + json(o, q.sortKey()) + " AS numeric) END) " + dir
                      + ", " + json(o, q.sortKey()) + " " + dir + ", seq";
            }
        }
        return new Compiled(where, whereArgs, order, o.args());
    }

    /** data->>key with the key bound (never written into the SQL text). */
    private static String json(SqlBuilder b, String key) { Names.key(key); return "(data->>" + b.arg(key) + ")"; }
}
