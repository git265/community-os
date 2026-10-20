package com.communityos.security;

import com.communityos.domain.ScopeNode;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.function.Predicate;
import java.util.function.UnaryOperator;

/**
 * Which rows of a collection a caller may see. `predicate` filters rows (null = all rows), `transform` rewrites rows they may see (null = as is,
 * e.g. another unit's booking shows only that the slot is taken), and `sql` is the same filter as data the database can apply
 * (null when it cannot be expressed exactly; the predicate is then applied in memory). `sql`, when present, means EXACTLY what `predicate` means.
 */
public record RowScope(Predicate<JsonNode> predicate, ScopeNode sql, UnaryOperator<JsonNode> transform) {
    public static final RowScope ALL = new RowScope(null, null, null);

    public static RowScope of(Predicate<JsonNode> predicate, ScopeNode sql) { return new RowScope(predicate, sql, null); }
    public static RowScope of(Predicate<JsonNode> predicate) { return new RowScope(predicate, null, null); }
    public static RowScope transform(UnaryOperator<JsonNode> transform) { return new RowScope(null, null, transform); }

    /** True when a request can be answered by the database alone: no in-memory row rule is left over. */
    public boolean databaseOnly() { return predicate == null || sql != null; }
}
