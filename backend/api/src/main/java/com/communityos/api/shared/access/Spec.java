package com.communityos.api.shared.access;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Specification pattern: one row rule, expressed BOTH as an SQL predicate (named parameters) for the database and as an in-memory predicate for a
 * single loaded row - the two must mean the same thing (the policy tests check both). Combined with and / or. Built by an AccessPolicy from the
 * Caller, never from request input. Parameter names are deterministic (s_unit_id, s_unit_id_2 ...), so the same rule gives the same SQL text.
 */
public record Spec<T>(String sql, Map<String, Object> params, Predicate<T> test) {

    public Spec { params = Map.copyOf(params); }

    public static <T> Spec<T> all() { return new Spec<>("TRUE", Map.of(), (t) -> true); }
    public static <T> Spec<T> none() { return new Spec<>("FALSE", Map.of(), (t) -> false); }
    /** column = :value */
    public static <T> Spec<T> eq(String column, Object value, Predicate<T> test) { String p = name(column); return new Spec<>(column + " = :" + p, Map.of(p, value), test); }
    /** column IN (:values); an empty collection matches nothing */
    public static <T> Spec<T> in(String column, Collection<?> values, Predicate<T> test) {
        if (values.isEmpty()) return none();
        String p = name(column);
        return new Spec<>(column + " IN (:" + p + ")", Map.of(p, List.copyOf(values)), test);
    }
    /** column IS NULL */
    public static <T> Spec<T> isNull(String column, Predicate<T> test) { return new Spec<>(column + " IS NULL", Map.of(), test); }

    public Spec<T> and(Spec<T> o) { return combine(o, "AND", test.and(o.test)); }
    public Spec<T> or(Spec<T> o) { return combine(o, "OR", test.or(o.test)); }
    public boolean matches(T row) { return test.test(row); }

    private static String name(String column) { return "s_" + column.replaceAll("[^A-Za-z0-9_]", "_"); }

    private Spec<T> combine(Spec<T> o, String op, Predicate<T> t) {
        Map<String, Object> merged = new LinkedHashMap<>(params);
        String other = o.sql;
        for (Map.Entry<String, Object> e : o.params.entrySet()) {
            String k = e.getKey();
            if (merged.containsKey(k)) {                       // same column used twice: give the second one its own name
                int i = 2; while (merged.containsKey(k + "_" + i) || o.params.containsKey(k + "_" + i)) i++;
                String renamed = k + "_" + i;
                other = other.replaceAll(":" + k + "\\b", ":" + renamed);
                merged.put(renamed, e.getValue());
            } else merged.put(k, e.getValue());
        }
        return new Spec<>("(" + sql + " " + op + " " + other + ")", merged, t);
    }
}
