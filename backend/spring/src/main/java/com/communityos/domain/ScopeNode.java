package com.communityos.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;

/**
 * A row-scope rule as data: "only the caller's own unit", "only their block". The UI's rule book (src/lib/security/authz.js)
 * writes it as JSON; this reads the same JSON. {@link ScopeSql} turns it into a WHERE clause, so the database filters the rows.
 */
public sealed interface ScopeNode {
    record All() implements ScopeNode {}
    record None() implements ScopeNode {}
    record Eq(String key, String value) implements ScopeNode {}
    record Ne(String key, String value) implements ScopeNode {}
    record In(String key, List<String> values) implements ScopeNode {}
    record Empty(String key) implements ScopeNode {}
    record NotEmpty(String key) implements ScopeNode {}
    record And(List<ScopeNode> of) implements ScopeNode {}
    record Or(List<ScopeNode> of) implements ScopeNode {}

    /** Reads the JSON tree; null / missing means "no restriction". */
    static ScopeNode parse(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) return new All();
        String op = n.path("op").asText("");
        String key = n.path("key").asText("");
        return switch (op) {
            case "true" -> new All();
            case "false" -> new None();
            case "eq" -> new Eq(key, n.path("value").isNull() ? "" : n.path("value").asText(""));
            case "ne" -> new Ne(key, n.path("value").isNull() ? "" : n.path("value").asText(""));
            case "in" -> { List<String> v = new ArrayList<>(); n.path("values").forEach(x -> v.add(x.asText(""))); yield new In(key, v); }
            case "empty" -> new Empty(key);
            case "notEmpty" -> new NotEmpty(key);
            case "and" -> new And(children(n));
            case "or" -> new Or(children(n));
            default -> throw new IllegalArgumentException("Unknown scope operator '" + op + "'");
        };
    }

    private static List<ScopeNode> children(JsonNode n) {
        List<ScopeNode> out = new ArrayList<>();
        n.path("of").forEach(c -> out.add(parse(c)));
        return out;
    }

    /** The language-neutral JSON form (the same tree the web app's rule book writes), for logs, tests and sending to other services. */
    default JsonNode toJson() {
        JsonNodeFactory f = JsonNodeFactory.instance;
        ObjectNode o = f.objectNode();
        switch (this) {
            case All a -> o.put("op", "true");
            case None n -> o.put("op", "false");
            case Eq e -> { o.put("op", "eq"); o.put("key", e.key()); o.put("value", e.value()); }
            case Ne e -> { o.put("op", "ne"); o.put("key", e.key()); o.put("value", e.value()); }
            case In i -> { o.put("op", "in"); o.put("key", i.key()); ArrayNode v = o.putArray("values"); i.values().forEach(v::add); }
            case Empty e -> { o.put("op", "empty"); o.put("key", e.key()); }
            case NotEmpty e -> { o.put("op", "notEmpty"); o.put("key", e.key()); }
            case And a -> { o.put("op", "and"); ArrayNode v = o.putArray("of"); a.of().forEach((c) -> v.add(c.toJson())); }
            case Or r -> { o.put("op", "or"); ArrayNode v = o.putArray("of"); r.of().forEach((c) -> v.add(c.toJson())); }
        }
        return o;
    }
}
