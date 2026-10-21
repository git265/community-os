package com.communityos.api.sql;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * Finds the :named parameters of a statement the way Spring's NamedParameterUtils does: not inside '...' literals or "..." identifiers, and
 * not the second colon of a :: cast. Used by the SQL check and the psql bridge so they substitute exactly what Spring would.
 */
public final class NamedSql {
    private NamedSql() {}
    /** Replaces each parameter by f(name). */
    public static String replace(String sql, Function<String, String> f) {
        StringBuilder out = new StringBuilder(); int i = 0, n = sql.length();
        while (i < n) {
            char ch = sql.charAt(i);
            if (ch == '\'' || ch == '"') { int j = sql.indexOf(ch, i + 1); if (j < 0) j = n - 1; out.append(sql, i, j + 1); i = j + 1; continue; }
            if (ch == ':' && i + 1 < n && sql.charAt(i + 1) == ':') { out.append("::"); i += 2; continue; }
            if (ch == ':' && i + 1 < n && (Character.isLetter(sql.charAt(i + 1)) || sql.charAt(i + 1) == '_')) {
                int j = i + 1; while (j < n && (Character.isLetterOrDigit(sql.charAt(j)) || sql.charAt(j) == '_')) j++;
                out.append(f.apply(sql.substring(i + 1, j))); i = j; continue;
            }
            out.append(ch); i++;
        }
        return out.toString();
    }
    public static List<String> names(String sql) { List<String> out = new ArrayList<>(); replace(sql, (x) -> { if (!out.contains(x)) out.add(x); return ""; }); return out; }
}
