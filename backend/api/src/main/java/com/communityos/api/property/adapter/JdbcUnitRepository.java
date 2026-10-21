package com.communityos.api.property.adapter;

import com.communityos.api.property.application.port.UnitRepository;
import com.communityos.api.property.domain.Unit;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** property.unit on the tenant connection. Lists use (community_id, block_id) / (community_id, unit_no) indexes; count via a window. */
public final class JdbcUnitRepository implements UnitRepository {
    static final String SELECT = """
        SELECT u.id, u.short_id, u.unit_no, u.block_id, b.name AS block_name, u.unit_type, u.occupancy, u.area_sqft, u.maintenance_plan, u.sanctioned_kw,
               u.status, u.custom::text AS custom, u.updated_at, u.version, count(*) OVER () AS total
        FROM property.unit u LEFT JOIN property.block b ON b.community_id = u.community_id AND b.id = u.block_id""";
    static final String FILTER = """
         WHERE (CAST(:q AS text) IS NULL OR u.unit_no ILIKE :q ESCAPE '\\')
           AND (CAST(:block AS uuid) IS NULL OR u.block_id = CAST(:block AS uuid))
           AND (CAST(:occupancy AS text) IS NULL OR u.occupancy = :occupancy)
           AND (CAST(:archived AS boolean) OR u.status = 'Active')""";
    public static String listSql(String scopeSql) { return SELECT + "\n" + FILTER + "\n  AND " + scopeSql + "\nORDER BY length(u.unit_no), u.unit_no LIMIT :limit OFFSET :offset"; }
    public static String getSql(String scopeSql) { return SELECT + "\nWHERE u.id = CAST(:id AS uuid) AND " + scopeSql; }
    static final String UPDATE = """
        UPDATE property.unit SET unit_no = :unitNo, unit_type = :type, occupancy = :occupancy, area_sqft = :area, maintenance_plan = :plan, sanctioned_kw = :kw, custom = CAST(:custom AS jsonb)
        WHERE id = CAST(:id AS uuid) AND version = :version""";
    static final String TYPES = "SELECT property_types FROM platform.community_settings";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcUnitRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public Page<Unit> find(Spec<Unit> scope, Filter f, PageQuery page) {
        Map<String, Object> p = new HashMap<>(scope.params());
        p.put("q", f.q() == null || f.q().isBlank() ? null : Rows.like(f.q().strip()));
        p.put("block", f.block() == null ? null : f.block().toString()); p.put("occupancy", f.occupancy()); p.put("archived", f.includeArchived());
        p.put("limit", page.limit()); p.put("offset", page.offset());
        long[] total = {0};
        List<Unit> rows = jdbc.query(listSql(scope.sql()), p,
            (rs, i) -> { total[0] = rs.getLong("total"); return map(rs); });
        return new Page<>(rows, total[0], page.limit(), page.offset());
    }
    @Override public Optional<Unit> findById(UnitId id, Spec<Unit> scope) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString());
        return jdbc.query(getSql(scope.sql()), p, (rs, i) -> map(rs)).stream().findFirst();
    }
    @Override public boolean save(Unit u, long expectedVersion) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", u.id().toString()); p.put("version", expectedVersion); p.put("unitNo", u.unitNo()); p.put("type", u.unitType()); p.put("occupancy", u.occupancy()); p.put("area", u.areaSqft());
        p.put("plan", u.maintenancePlan()); p.put("kw", u.sanctionedKw());
        try { p.put("custom", json.writeValueAsString(u.custom())); } catch (Exception e) { throw new IllegalStateException(e); }
        return jdbc.update(UPDATE, p) == 1;
    }
    @Override public Set<String> propertyTypes() {
        return jdbc.query(TYPES, Map.of(), (rs, i) -> Rows.set(rs, "property_types", String::valueOf)).stream().findFirst().orElse(Set.of("Villa", "Apartment"));
    }

    private Unit map(ResultSet rs) throws SQLException {
        Map<String, Object> custom;
        try { custom = json.readValue(rs.getString("custom"), new TypeReference<Map<String, Object>>() {}); } catch (java.io.IOException e) { throw new SQLException(e); }
        UUID block = Rows.uuid(rs, "block_id");
        return new Unit(new UnitId(Rows.uuid(rs, "id")), rs.getString("short_id"), rs.getString("unit_no"), block == null ? null : new BlockId(block), rs.getString("block_name"),
            rs.getString("unit_type"), rs.getString("occupancy"), rs.getBigDecimal("area_sqft"), rs.getString("maintenance_plan"), rs.getBigDecimal("sanctioned_kw"),
            rs.getString("status"), custom, Rows.instant(rs, "updated_at"), rs.getLong("version"));
    }
}
