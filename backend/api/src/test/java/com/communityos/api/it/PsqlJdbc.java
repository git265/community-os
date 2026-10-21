package com.communityos.api.it;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.tx.Tx;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Proxy;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * Runs the REAL JDBC adapters against PostgreSQL through one long-lived psql session (this build environment has no JDBC driver; with Maven
 * the same flow test runs on Testcontainers + PgJDBC). Named parameters are rendered as literals the way NamedParameterJdbcTemplate expands
 * them; rows come back as CSV and are served to the RowMappers through a ResultSet proxy. Like TenantDataSource, every statement on the app
 * session first sets app.community_id / app.user_id from the current caller. Also a Tx (BEGIN / COMMIT / ROLLBACK, nesting = join).
 */
public final class PsqlJdbc extends NamedParameterJdbcTemplate implements Tx, AutoCloseable {
    public static final class SqlError extends RuntimeException { public final String state; SqlError(String state, String m) { super(m); this.state = state; } }
    /** the local PostgreSQL port (PGPORT, default 5433) */
    public static final String PORT = System.getenv().getOrDefault("PGPORT", "5433");
    private static final Pattern UUID_RE = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    private final Process psql; private final Writer in; private final BufferedReader out; private final StringBuilder err = new StringBuilder();
    private final boolean tenant; private int depth; private boolean failed;
    public int statements;

    public PsqlJdbc(String db, String role, boolean tenant) throws Exception {
        super(new org.springframework.jdbc.core.JdbcTemplate());   // never used: every call goes to psql below (super(null) is ambiguous and fails the null check)
        this.tenant = tenant;
        psql = new ProcessBuilder("psql", "-h", "localhost", "-p", PORT, "-U", "postgres", "-d", db, "-X", "-q", "-v", "VERBOSITY=verbose").start();
        in = new OutputStreamWriter(psql.getOutputStream(), StandardCharsets.UTF_8);
        out = new BufferedReader(new InputStreamReader(psql.getInputStream(), StandardCharsets.UTF_8));
        Thread t = new Thread(() -> { try (BufferedReader e = new BufferedReader(new InputStreamReader(psql.getErrorStream(), StandardCharsets.UTF_8))) {
            for (String l; (l = e.readLine()) != null; ) synchronized (err) { err.append(l).append('\n'); } } catch (Exception ignored) { } });
        t.setDaemon(true); t.start();
        in.write("\\pset format csv\n\\pset tuples_only off\n\\pset null '" + NULL + "'\n"); in.flush();
        raw("SET client_min_messages = warning; SET TIME ZONE 'UTC'" + (role == null ? "" : "; SET ROLE " + role));
    }

    // ---- NamedParameterJdbcTemplate ------------------------------------------------------------------------------------------------------
    @Override public <T> List<T> query(String sql, Map<String, ?> params, RowMapper<T> mapper) {
        List<Map<String, Object>> rows = rows(render(sql, params));
        List<T> outRows = new ArrayList<>();
        try { for (int i = 0; i < rows.size(); i++) outRows.add(mapper.mapRow(resultSet(rows.get(i)), i)); } catch (java.sql.SQLException e) { throw new IllegalStateException(e); }
        return outRows;
    }
    @Override public int update(String sql, Map<String, ?> params) {
        String s = render(sql, params);
        String q = s.toUpperCase().contains("RETURNING") ? s : s + " RETURNING 1";
        return Integer.parseInt((String) rowsOf("WITH t AS (" + q + ") SELECT count(*) AS n FROM t").get(0).get("n"));
    }
    @Override public <T> T queryForObject(String sql, Map<String, ?> params, Class<T> type) {
        List<Map<String, Object>> rows = rows(render(sql, params));
        if (rows.size() != 1) throw new IllegalStateException("expected one row, got " + rows.size());
        return convert(rows.get(0).values().iterator().next(), type);
    }

    /** Run as the owner (superuser) to set up fixtures. */
    public List<Map<String, Object>> sql(String s) { return rows(s); }

    // ---- Tx ------------------------------------------------------------------------------------------------------------------------------------
    @Override public <T> T inTx(Supplier<T> work) {
        if (depth++ > 0) { try { return work.get(); } finally { depth--; } }
        raw("BEGIN");
        failed = false;
        try {
            T r = work.get();
            depth = 0;
            raw("COMMIT");
            return r;
        } catch (RuntimeException e) {
            depth = 0;
            try { raw("ROLLBACK"); } catch (RuntimeException ignored) { }
            throw e;
        }
    }

    // ---- plumbing ----------------------------------------------------------------------------------------------------------------------------
    /** Rows of a SELECT / RETURNING statement, read from psql's CSV output (header + values; NULL printed as a marker). */
    private List<Map<String, Object>> rows(String sql) { return rowsOf(sql.strip()); }
    private List<Map<String, Object>> rowsOf(String q) {
        String text = raw(context() + q);
        List<List<String>> recs = csv(text);
        List<Map<String, Object>> outRows = new ArrayList<>();
        if (recs.isEmpty()) return outRows;
        List<String> head = recs.get(0);
        for (List<String> r : recs.subList(1, recs.size())) {
            Map<String, Object> m = new java.util.LinkedHashMap<>();
            for (int i = 0; i < head.size(); i++) m.put(head.get(i), NULL.equals(r.get(i)) ? null : r.get(i));
            outRows.add(m);
        }
        return outRows;
    }
    static final String NULL = "␀NULL";
    static List<List<String>> csv(String text) {
        List<List<String>> recs = new ArrayList<>(); List<String> cur = new ArrayList<>(); StringBuilder f = new StringBuilder();
        boolean q = false, any = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i); any = true;
            if (q) { if (c == '"') { if (i + 1 < text.length() && text.charAt(i + 1) == '"') { f.append('"'); i++; } else q = false; } else f.append(c); }
            else if (c == '"') q = true;
            else if (c == ',') { cur.add(f.toString()); f.setLength(0); }
            else if (c == '\n') { cur.add(f.toString()); f.setLength(0); recs.add(cur); cur = new ArrayList<>(); any = false; }
            else f.append(c);
        }
        if (any) { cur.add(f.toString()); recs.add(cur); }
        return recs;
    }
    private String context() {
        if (!tenant) return "";
        Caller c = CallerHolder.current().orElse(null);
        return "SELECT set_config('app.community_id', " + lit(c == null ? "" : c.community().toString()) + ", false), set_config('app.user_id', "
            + lit(c == null || c.membership() == null ? "" : c.membership().toString()) + ", false) \\g /dev/null\n";
    }
    private synchronized String raw(String sql) {
        statements++;
        synchronized (err) { err.setLength(0); }
        try {
            in.write(sql); in.write(";\n\\echo __END__\n\\warn __END__\n"); in.flush();
            StringBuilder b = new StringBuilder();
            for (String l; (l = out.readLine()) != null && !l.equals("__END__"); ) b.append(l).append('\n');
            // the errors of this statement are on stderr before its end marker (read by another thread): wait for the marker, not for a guess
            String e;
            for (long until = System.currentTimeMillis() + 10_000; ; Thread.sleep(1)) {
                synchronized (err) { e = err.toString(); }
                if (e.contains("__END__") || System.currentTimeMillis() > until) break;
            }
            if (e.contains("ERROR")) {
                Matcher m = Pattern.compile("ERROR:\\s+([0-9A-Z]{5}):\\s*(.*)").matcher(e);
                String state = m.find() ? m.group(1) : "?????", msg = m.group(0);
                if (state.equals("23505")) throw new DuplicateKeyException(msg);
                if (state.startsWith("23")) throw new DataIntegrityViolationException(msg);
                throw new SqlError(state, msg + "\n  in: " + sql.substring(0, Math.min(400, sql.length())));
            }
            return b.toString().strip();
        } catch (java.io.IOException | InterruptedException e) { throw new IllegalStateException(e); }
    }

    static String render(String sql, Map<String, ?> params) {
        return com.communityos.api.sql.NamedSql.replace(sql, (name) -> {
            if (!params.containsKey(name)) throw new IllegalArgumentException("no value for :" + name + " in " + sql);
            Object v = params.get(name);
            return v instanceof Collection<?> c ? String.join(", ", c.stream().map(PsqlJdbc::lit).toList()) : lit(v);
        });
    }
    static String lit(Object v) {
        if (v == null) return "NULL";
        if (v instanceof Number n) return n instanceof BigDecimal b ? b.toPlainString() : n.toString();
        if (v instanceof Boolean b) return b.toString();
        if (v instanceof byte[] b) return "'\\x" + HexFormat.of().formatHex(b) + "'::bytea";
        if (v instanceof java.sql.Timestamp t) return "'" + t.toInstant() + "'";
        return "'" + v.toString().replace("'", "''") + "'";
    }

    @SuppressWarnings("unchecked")
    static <T> T convert(Object v, Class<T> type) {
        if (v == null) return null;
        String t = v.toString();
        if (type == UUID.class) return (T) UUID.fromString(t);
        if (type == BigDecimal.class) return (T) new BigDecimal(t);
        if (type == Long.class) return (T) Long.valueOf(t);
        if (type == Integer.class) return (T) Integer.valueOf(t);
        if (type == Boolean.class) return (T) Boolean.valueOf(t.equals("t"));
        if (type == String.class) return (T) t;
        throw new IllegalArgumentException("convert to " + type);
    }

    static ResultSet resultSet(Map<String, Object> row) {
        return (ResultSet) Proxy.newProxyInstance(ResultSet.class.getClassLoader(), new Class<?>[]{ResultSet.class}, (p, m, a) -> {
            String col = a != null && a.length > 0 && a[0] instanceof String s ? s : null;
            if (col != null && !row.containsKey(col)) throw new java.sql.SQLException("no column " + col + " in " + row.keySet());
            String v = col == null ? null : (String) row.get(col);
            return switch (m.getName()) {
                case "getString" -> v;
                case "getObject" -> v == null ? null : a.length > 1 && a[1] == UUID.class ? UUID.fromString(v) : v;
                case "getBigDecimal" -> v == null ? null : new BigDecimal(v);
                case "getBoolean" -> "t".equals(v);
                case "getInt" -> v == null ? 0 : Integer.parseInt(v);
                case "getLong" -> v == null ? 0L : Long.parseLong(v);
                case "getTimestamp" -> v == null ? null : java.sql.Timestamp.from(OffsetDateTime.parse(v.replace(' ', 'T').replaceAll("([+-]\\d\\d)$", "$1:00")).toInstant());
                case "getDate" -> v == null ? null : java.sql.Date.valueOf(v.substring(0, 10));
                case "getBytes" -> v == null ? null : HexFormat.of().parseHex(v.substring(2));
                case "getArray" -> v == null ? null : array(pgArray(v));
                case "wasNull" -> false;
                default -> throw new UnsupportedOperationException(m.getName());
            };
        });
    }
    /** {a,"b c",NULL} -> [a, b c, null] (one dimension). */
    static List<String> pgArray(String s) {
        List<String> outL = new ArrayList<>();
        String body = s.substring(1, s.length() - 1);
        if (body.isEmpty()) return outL;
        StringBuilder f = new StringBuilder(); boolean q = false, quoted = false;
        for (int i = 0; i < body.length(); i++) {
            char c = body.charAt(i);
            if (q) { if (c == '\\') f.append(body.charAt(++i)); else if (c == '"') q = false; else f.append(c); }
            else if (c == '"') { q = true; quoted = true; }
            else if (c == ',') { outL.add(!quoted && f.toString().equals("NULL") ? null : f.toString()); f.setLength(0); quoted = false; }
            else f.append(c);
        }
        outL.add(!quoted && f.toString().equals("NULL") ? null : f.toString());
        return outL;
    }
    static java.sql.Array array(List<String> list) {
        Object[] values = list.stream().map((x) -> x != null && UUID_RE.matcher(x).matches() ? (Object) UUID.fromString(x) : x).toArray();
        return (java.sql.Array) Proxy.newProxyInstance(java.sql.Array.class.getClassLoader(), new Class<?>[]{java.sql.Array.class}, (p, m, a) -> {
            if (m.getName().equals("getArray")) return values;
            throw new UnsupportedOperationException(m.getName());
        });
    }

    @Override public void close() { try { in.write("\\q\n"); in.flush(); } catch (Exception ignored) { } psql.destroy(); }
}
