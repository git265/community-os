package com.communityos.adapter.persistence.typed;

import com.communityos.domain.ScopeNode;
import com.communityos.web.Names;
import java.util.ArrayList;
import java.util.List;

/** Collects a WHERE clause and its bind values together, so a value can never be glued into the SQL text. */
final class SqlBuilder {
    private final List<Object> args = new ArrayList<>();
    private final List<String> where = new ArrayList<>();
    private final CollectionMapping mapping;   // null for the generic documents table

    SqlBuilder(CollectionMapping mapping) { this.mapping = mapping; }

    /** Adds a bind value and returns its placeholder. */
    String arg(Object v) { args.add(v); return "?"; }
    void and(String clause) { where.add(clause); }
    String whereClause() { return String.join(" AND ", where); }
    List<Object> args() { return args; }
    CollectionMapping mapping() { return mapping; }

    /** Text expression for a JSON field: the real column when there is one, else data->>key (the key is validated, then bound). */
    String text(String key) {
        String col = mapping == null ? null : mapping.textColumn(key);
        if (col != null) return col;
        Names.key(key);
        return "(data->>" + arg(key) + ")";
    }
    boolean hasColumn(String key) { return mapping != null && mapping.textColumn(key) != null; }
}
