package com.communityos.adapter.persistence.typed;

import com.communityos.domain.ScopeNode;
import java.util.List;
import java.util.stream.Collectors;

/** Scope tree -> WHERE fragment. Same result as backend/contract-server/store/sqlquery.mjs (checked there against the in-memory rule). */
final class ScopeSql {
    private ScopeSql() {}

    static String toSql(ScopeNode n, SqlBuilder b) {
        return switch (n) {
            case ScopeNode.All a -> "TRUE";
            case ScopeNode.None x -> "FALSE";
            case ScopeNode.Eq e -> e.value().isEmpty()
                    ? "COALESCE(" + b.text(e.key()) + ", '') = ''"
                    : (b.hasColumn(e.key()) ? b.text(e.key()) + " = " + b.arg(e.value()) : "COALESCE(" + b.text(e.key()) + ", '') = " + b.arg(e.value()));
            case ScopeNode.Ne e -> "COALESCE(" + b.text(e.key()) + ", '') <> " + b.arg(e.value());
            case ScopeNode.Empty e -> "COALESCE(" + b.text(e.key()) + ", '') = ''";
            case ScopeNode.NotEmpty e -> "COALESCE(" + b.text(e.key()) + ", '') <> ''";
            case ScopeNode.In i -> in(i, b);
            case ScopeNode.And a -> a.of().isEmpty() ? "TRUE" : join(a.of(), " AND ", b);
            case ScopeNode.Or o -> o.of().isEmpty() ? "FALSE" : join(o.of(), " OR ", b);
        };
    }

    private static String in(ScopeNode.In i, SqlBuilder b) {
        if (i.values().isEmpty()) return "FALSE";
        List<String> nonEmpty = i.values().stream().filter(v -> !v.isEmpty()).toList();
        // each use of text() binds its own placeholder (a JSON key is a bind value), so call it again where it is written again
        String base = b.text(i.key()) + " = ANY(" + b.arg(nonEmpty.toArray(new String[0])) + ")";
        if (!i.values().contains("")) return base;
        return "(" + base + " OR COALESCE(" + b.text(i.key()) + ", '') = '')";
    }

    private static String join(List<ScopeNode> of, String op, SqlBuilder b) {
        return "(" + of.stream().map(c -> toSql(c, b)).collect(Collectors.joining(op)) + ")";
    }
}
