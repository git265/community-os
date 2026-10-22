package com.communityos.api.shared.resource;

import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Constructor;
import java.lang.reflect.RecordComponent;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Template Method: the same JDBC mechanics for every resource; the table description supplies the SQL and the columns. */
public final class JdbcResourceRepository<F extends Record> implements ResourceRepository<F> {
    private final ResourceTable<F> t; private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json; private final Constructor<F> ctor;
    private final RecordComponent[] comps;

    public JdbcResourceRepository(ResourceTable<F> table, NamedParameterJdbcTemplate jdbc, ObjectMapper json) {
        this.t = table; this.jdbc = jdbc; this.json = json; this.comps = table.type().getRecordComponents();
        try { this.ctor = table.type().getDeclaredConstructor(java.util.Arrays.stream(comps).map(RecordComponent::getType).toArray(Class[]::new)); ctor.setAccessible(true); }
        catch (NoSuchMethodException e) { throw new IllegalStateException(e); }
    }

    @Override public List<Item<F>> list(Spec<F> scope) { return list(scope, Map.of()); }
    @Override public List<Item<F>> list(Spec<F> scope, Map<String, String> filters) {
        Map<String, Object> p = new HashMap<>(scope.params());
        java.util.List<String> used = t.filters().stream().filter(filters::containsKey).toList();
        for (String f : used) p.put("f_" + f, filters.get(f));
        return jdbc.query(t.selectSql(scope.sql(), t.filterSql(used)), p, (rs, i) -> map(rs));
    }
    @Override public Optional<Item<F>> get(UUID id, Spec<F> scope) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString());
        return jdbc.query(t.getSql(scope.sql()), p, (rs, i) -> map(rs)).stream().findFirst();
    }
    @Override public UUID insert(F f) { return jdbc.queryForObject(t.insertSql(), params(f), UUID.class); }
    @Override public long update(UUID id, long version, F f) {
        Map<String, Object> p = params(f); p.put("id", id.toString()); p.put("version", version);
        List<Long> v = jdbc.query(t.updateSql(), p, (rs, i) -> rs.getLong("version"));
        return v.isEmpty() ? -1 : v.get(0);
    }
    @Override public boolean delete(UUID id, long version) { return jdbc.update(t.deleteSql(), Map.of("id", id.toString(), "version", version)) == 1; }

    private Map<String, Object> params(F f) {
        Map<String, Object> p = new HashMap<>();
        for (int i = 0; i < comps.length; i++) {
            ResourceTable.Column c = t.columns().get(i);
            Object v;
            try { v = comps[i].getAccessor().invoke(f); } catch (ReflectiveOperationException e) { throw new IllegalStateException(e); }
            p.put(c.field(), toParam(c.kind(), v, comps[i].getType()));
        }
        return p;
    }
    private Object toParam(ResourceTable.Kind k, Object v, Class<?> type) {
        if (v == null) {   // NOT NULL collections are never sent as null: an absent list is an empty one
            if (k == ResourceTable.Kind.TEXT_ARRAY || k == ResourceTable.Kind.UUID_ARRAY) return "{}";
            if (k == ResourceTable.Kind.JSON) return type == Map.class ? "{}" : "[]";
            return null;
        }
        return switch (k) {
            case MONEY -> ((Money) v).amount();
            case DATE -> java.sql.Date.valueOf((java.time.LocalDate) v);
            case TIME -> v.toString();
            case TIMESTAMP -> Rows.ts((java.time.Instant) v);
            case UUID -> v.toString();
            case TEXT_ARRAY, UUID_ARRAY -> pgArray((List<?>) v);
            case JSON -> write(v);
            default -> v;
        };
    }
    @Override public boolean exists(String sql, java.util.Map<String, Object> params) { return !jdbc.query(sql, params, (rs, i) -> 1).isEmpty(); }
    static String pgArray(List<?> list) { return com.communityos.api.shared.jdbc.Rows.pgArray(list); }

    private Item<F> map(ResultSet rs) throws SQLException {
        Object[] args = new Object[comps.length];
        for (int i = 0; i < comps.length; i++) args[i] = read(rs, t.columns().get(i), comps[i]);
        try {
            Map<String, Object> server = new java.util.LinkedHashMap<>();
            for (ResourceTable.ServerColumn sc : t.serverColumns()) {
                server.put(sc.field(), serverValue(rs, sc.alias(), sc.kind()));
            }
            return new Item<>(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getLong("version"), Rows.instant(rs, "created_at"), Rows.instant(rs, "updated_at"), ctor.newInstance(args), server);
        } catch (ReflectiveOperationException e) { throw new SQLException(e); }
    }
    private Object read(ResultSet rs, ResourceTable.Column c, RecordComponent rc) throws SQLException {
        String col = c.column();
        return switch (c.kind()) {
            case TEXT -> rs.getString(col);
            case BOOL -> { String s = rs.getString(col); yield s == null ? (rc.getType() == boolean.class ? false : null) : rs.getBoolean(col); }
            case INT -> { BigDecimal b = rs.getBigDecimal(col); yield b == null ? (rc.getType() == int.class ? 0 : null) : (rc.getType() == Long.class ? (Object) b.longValue() : (Object) b.intValue()); }
            case NUMERIC -> rs.getBigDecimal(col);
            case MONEY -> Rows.money(rs, col);
            case DATE -> Rows.date(rs, col);
            case TIME -> { String s = rs.getString(col); yield s == null ? null : java.time.LocalTime.parse(s); }
            case TIMESTAMP -> Rows.instant(rs, col);
            case UUID -> Rows.uuid(rs, col);
            case TEXT_ARRAY -> Rows.list(rs, col, String::valueOf);
            case UUID_ARRAY -> Rows.list(rs, col, (o) -> o instanceof UUID u ? u : UUID.fromString(o.toString()));
            case JSON -> {
                String s = rs.getString(col);
                if (s == null) yield null;
                try { JavaType jt = json.getTypeFactory().constructType(rc.getGenericType()); yield json.readValue(s, jt); } catch (java.io.IOException e) { throw new SQLException(e); }
            }
        };
    }
    private Object serverValue(ResultSet rs, String col, ResourceTable.Kind k) throws SQLException {
        return switch (k) {
            case BOOL -> rs.getString(col) == null ? null : rs.getBoolean(col);
            case INT -> { BigDecimal b = rs.getBigDecimal(col); yield b == null ? null : b.longValue(); }
            case NUMERIC -> rs.getBigDecimal(col);
            case MONEY -> { Money m = Rows.money(rs, col); yield m == null ? null : m.amount().setScale(2, java.math.RoundingMode.HALF_UP).toPlainString(); }
            case DATE -> Rows.date(rs, col);
            case TIMESTAMP -> Rows.instant(rs, col);
            case UUID -> Rows.uuid(rs, col);
            case TEXT_ARRAY, UUID_ARRAY -> Rows.list(rs, col, String::valueOf);
            case JSON -> { String s = rs.getString(col); try { yield s == null ? null : json.readTree(s); } catch (java.io.IOException e) { throw new SQLException(e); } }
            default -> rs.getString(col);
        };
    }
    private String write(Object v) { try { return json.writeValueAsString(v); } catch (Exception e) { throw new IllegalStateException(e); } }
}
