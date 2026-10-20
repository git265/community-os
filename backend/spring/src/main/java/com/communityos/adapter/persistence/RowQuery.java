package com.communityos.adapter.persistence;

import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * Filter, search, sort and page a list of records held in memory. Same meaning as src/lib/storage/queryEngine.js. Used by the in-memory
 * adapter and by the secure read path when a caller's row scope cannot be written as SQL (the rows are already scoped and masked).
 */
public final class RowQuery {
    private RowQuery() {}

    public static PageResult run(List<JsonNode> all, QuerySpec q) {
        List<JsonNode> rows = all;
        for (Map.Entry<String, List<String>> f : q.filters().entrySet()) {
            rows = rows.stream().filter(r -> {
                String v = text(r, f.getKey());
                return f.getValue().contains("__none__") ? v.isEmpty() : f.getValue().isEmpty() || f.getValue().contains(v);
            }).toList();
        }
        if (nb(q.dateKey())) rows = rows.stream().filter(r -> {
            String d = text(r, q.dateKey()); d = d.length() >= 10 ? d.substring(0, 10) : d;
            return (!nb(q.from()) || d.compareTo(q.from()) >= 0) && (!nb(q.to()) || d.compareTo(q.to()) <= 0);
        }).toList();
        if (nb(q.periodKey())) rows = rows.stream().filter(r -> {
            String[] p = text(r, q.periodKey()).split("-");
            return (!nb(q.year()) || (p.length > 0 && p[0].equals(q.year()))) && (!nb(q.month()) || (p.length > 1 && p[1].equals(q.month())));
        }).toList();
        if (nb(q.search())) {
            String needle = q.search().toLowerCase();
            rows = rows.stream().filter(r -> {
                if (!q.searchKeys().isEmpty()) return q.searchKeys().stream().anyMatch(k -> text(r, k).toLowerCase().contains(needle));
                for (JsonNode v : r) if (v.isValueNode() && v.asText().toLowerCase().contains(needle)) return true;
                return false;
            }).toList();
        }
        if (nb(q.sortKey())) {
            Comparator<JsonNode> cmp = (a, b) -> compare(text(a, q.sortKey()), text(b, q.sortKey()));
            rows = rows.stream().sorted("desc".equalsIgnoreCase(q.sortDir()) ? cmp.reversed() : cmp).toList();
        }
        int size = Math.min(1000, Math.max(1, q.pageSize()));
        int pages = Math.max(1, (int) Math.ceil(rows.size() / (double) size));
        int page = Math.min(Math.max(1, q.page()), pages);
        return new PageResult(rows.stream().skip((long) (page - 1) * size).limit(size).toList(), rows.size(), page, size, pages);
    }

    private static boolean nb(String s) { return s != null && !s.isBlank(); }
    private static String text(JsonNode r, String k) { JsonNode v = r.get(k); return v == null || v.isNull() ? "" : v.asText(); }
    private static final java.util.regex.Pattern NUM = java.util.regex.Pattern.compile("^-?[0-9]+(\\.[0-9]+)?$");
    private static int compare(String a, String b) {
        boolean an = NUM.matcher(a).matches(), bn = NUM.matcher(b).matches();
        if (an && bn) return new java.math.BigDecimal(a).compareTo(new java.math.BigDecimal(b));
        if (an != bn) return an ? -1 : 1;
        return a.compareTo(b);
    }
}
