package com.communityos.api.shared.resource;

import com.communityos.api.shared.domain.Money;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.RecordComponent;
import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * How one resource is stored: the table, and one column per field of its record (camelCase field = snake_case column unless renamed).
 * The SQL is built once from that list and is public, so the SQL check runs exactly the statements the repository sends.
 */
public final class ResourceTable<F extends Record> {
    public enum Kind { TEXT, BOOL, INT, NUMERIC, MONEY, DATE, TIME, TIMESTAMP, UUID, TEXT_ARRAY, UUID_ARRAY, JSON }
    public record Column(String field, String column, Kind kind) {
        String cast() {
            return switch (kind) {
                case TEXT -> "text"; case BOOL -> "boolean"; case INT -> "integer"; case NUMERIC, MONEY -> "numeric"; case DATE -> "date"; case TIME -> "time"; case TIMESTAMP -> "timestamptz";
                case UUID -> "uuid"; case TEXT_ARRAY -> "text[]"; case UUID_ARRAY -> "uuid[]"; case JSON -> "jsonb";
            };
        }
        String select() { return kind == Kind.JSON ? "r." + column + "::text AS " + column : kind == Kind.TIME ? "to_char(r." + column + ", 'HH24:MI') AS " + column : "r." + column; }
    }

    /** A column only the server writes: returned with the record (read-only), and set on insert from a SQL expression when one is given. */
    public record ServerColumn(String field, String column, Kind kind, String insertExpr, String selectExpr) {
        String alias() { return "sv_" + ResourceTable.snake(field); }
        String select() {
            if (selectExpr != null) return selectExpr + " AS " + alias();
            return (kind == Kind.JSON ? "r." + column + "::text" : kind == Kind.TIME ? "to_char(r." + column + ", 'HH24:MI')" : "r." + column) + " AS " + alias();
        }
    }

    private final String collection, path, table, orderBy; private final Class<F> type; private final List<Column> columns;
    private final List<ServerColumn> server = new ArrayList<>(); private final List<String> filters = new ArrayList<>();

    public ResourceTable(String collection, String path, String table, Class<F> type, String orderBy, Map<String, String> renamed) {
        this.collection = collection; this.path = path; this.table = table; this.type = type; this.orderBy = orderBy;
        List<Column> cols = new ArrayList<>();
        for (RecordComponent rc : type.getRecordComponents()) cols.add(new Column(rc.getName(), renamed.getOrDefault(rc.getName(), snake(rc.getName())), kindOf(rc)));
        this.columns = List.copyOf(cols);
    }
    public ResourceTable(String collection, String path, String table, Class<F> type, String orderBy) { this(collection, path, table, type, orderBy, Map.of()); }

    public String collection() { return collection; } public String path() { return path; } public String table() { return table; } public Class<F> type() { return type; }
    public List<Column> columns() { return columns; }
    public List<ServerColumn> serverColumns() { return List.copyOf(server); }
    public List<String> filters() { return List.copyOf(filters); }

    /** A read-only column the server sets (who created it, a status a workflow moves ...). insertExpr may be null (left to its default). */
    public ResourceTable<F> server(String field, String column, Kind kind, String insertExpr) { server.add(new ServerColumn(field, column, kind, insertExpr, null)); return this; }
    /** A computed, read-only value (a name looked up from an id ...). */
    public ResourceTable<F> computed(String field, Kind kind, String selectExpr) { server.add(new ServerColumn(field, null, kind, null, selectExpr)); return this; }
    /** "Who" columns: <name>_id is the caller's membership (set by the server on insert), and <name> is that member's display name. */
    public ResourceTable<F> who(String name) { return who(name, snake(name) + "_id", true); }
    public ResourceTable<F> who(String name, String column, boolean stampOnInsert) {
        server(name + "Id", column, Kind.UUID, stampOnInsert ? "platform.current_actor()" : null);
        return computed(name, Kind.TEXT, "(SELECT m.display_name FROM identity.membership m WHERE m.id = r." + column + ")");
    }
    /** The unit number next to a unit id field (read-only, for display). */
    public ResourceTable<F> unitNo(String field, String column) { return computed(field, Kind.TEXT, "(SELECT u.unit_no FROM property.unit u WHERE u.id = r." + column + ")"); }
    public ResourceTable<F> server(String field, Kind kind, String insertExpr) { return server(field, snake(field), kind, insertExpr); }
    public ResourceTable<F> server(String field, Kind kind) { return server(field, snake(field), kind, null); }
    /** Fields a list may be narrowed by (?eventId=...): equality on that column. */
    public ResourceTable<F> filterBy(String... fields) {
        for (String f : fields) { if (column(f) == null) throw new IllegalArgumentException(collection + ": no field " + f); filters.add(f); }
        return this;
    }
    public Column column(String field) { return columns.stream().filter((c) -> c.field().equals(field)).findFirst().orElse(null); }
    /** The list filter for the given fields (AND of equalities, params f_<field>). */
    public String filterSql(java.util.Collection<String> fields) {
        StringBuilder b = new StringBuilder();
        for (String f : fields) { Column c = column(f); b.append(" AND r.").append(c.column()).append(" = CAST(:f_").append(f).append(" AS ").append(c.cast()).append(")"); }
        return b.toString();
    }
    private String selectList() {
        String s = "SELECT r.id, r.short_id, r.version, r.created_at, r.updated_at, " + columns.stream().map(Column::select).collect(Collectors.joining(", "));
        return server.isEmpty() ? s : s + ", " + server.stream().map(ServerColumn::select).collect(Collectors.joining(", "));
    }

    public String selectSql(String scopeSql) { return selectSql(scopeSql, ""); }
    public String selectSql(String scopeSql, String filterSql) {
        return selectList() + "\nFROM " + table + " r\nWHERE (" + scopeSql + ")" + filterSql + "\nORDER BY " + orderBy + ", r.id LIMIT 2000";
    }
    public String getSql(String scopeSql) { return selectList() + "\nFROM " + table + " r\nWHERE r.id = CAST(:id AS uuid) AND (" + scopeSql + ")"; }
    public String insertSql() {
        List<ServerColumn> set = server.stream().filter((c) -> c.insertExpr() != null && c.column() != null).toList();
        return "INSERT INTO " + table + " (community_id, " + columns.stream().map(Column::column).collect(Collectors.joining(", "))
            + set.stream().map((c) -> ", " + c.column()).collect(Collectors.joining()) + ")\nVALUES (platform.current_community(), "
            + columns.stream().map((c) -> "CAST(:" + c.field() + " AS " + c.cast() + ")").collect(Collectors.joining(", "))
            + set.stream().map((c) -> ", " + c.insertExpr()).collect(Collectors.joining()) + ")\nRETURNING id";
    }
    public String updateSql() {
        return "UPDATE " + table + " SET " + columns.stream().map((c) -> c.column() + " = CAST(:" + c.field() + " AS " + c.cast() + ")").collect(Collectors.joining(", "))
            + "\nWHERE id = CAST(:id AS uuid) AND version = :version RETURNING version";
    }
    public String deleteSql() { return "DELETE FROM " + table + " WHERE id = CAST(:id AS uuid) AND version = :version"; }

    static String snake(String camel) { return camel.replaceAll("([a-z0-9])([A-Z])", "$1_$2").toLowerCase(); }

    private static Kind kindOf(RecordComponent rc) {
        Class<?> t = rc.getType();
        if (t == String.class) return Kind.TEXT;
        if (t == Boolean.class || t == boolean.class) return Kind.BOOL;
        if (t == Integer.class || t == int.class || t == Long.class) return Kind.INT;
        if (t == BigDecimal.class) return Kind.NUMERIC;
        if (t == Money.class) return Kind.MONEY;
        if (t == LocalDate.class) return Kind.DATE;
        if (t == java.time.LocalTime.class) return Kind.TIME;
        if (t == Instant.class) return Kind.TIMESTAMP;
        if (t == UUID.class) return Kind.UUID;
        if (t == Map.class) return Kind.JSON;
        if (t == List.class) {
            Type g = rc.getGenericType();
            Type arg = g instanceof ParameterizedType p ? p.getActualTypeArguments()[0] : String.class;
            if (arg == UUID.class) return Kind.UUID_ARRAY;
            if (arg == String.class) return Kind.TEXT_ARRAY;
            return Kind.JSON;                                     // a list of objects (line items, slots ...) is stored as jsonb
        }
        throw new IllegalArgumentException(rc.getName() + ": no column kind for " + t);
    }
}
