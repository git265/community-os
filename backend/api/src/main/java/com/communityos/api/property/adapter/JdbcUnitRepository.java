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
    /** The unit with who to call there: its primary owner, else a co-owner, else the tenant (current occupants only, through the (community, unit) index). */
    static final String COLUMNS = """
        SELECT u.id, u.short_id, u.unit_no, u.block_id, b.name AS block_name, u.unit_type, u.occupancy, u.area_sqft, u.maintenance_plan, u.sanctioned_kw,
               u.status, u.bill_to, u.custom::text AS custom, u.updated_at, u.version, o.full_name AS contact_name, o.phone_e164 AS contact_phone, o.relation AS contact_relation""";
    /** The unit's block and who to call there (`u` is the unit). */
    static final String JOINS = """
        LEFT JOIN property.block b ON b.community_id = u.community_id AND b.id = u.block_id
        LEFT JOIN LATERAL (
          SELECT x.full_name, x.phone_e164, x.relation FROM property.occupant x
          WHERE x.community_id = u.community_id AND x.unit_id = u.id AND x.to_date IS NULL AND x.relation IN ('Owner', 'Co-owner', 'Tenant')
          ORDER BY (x.relation = 'Owner' AND x.is_primary) DESC, (x.relation = 'Owner') DESC, (x.relation = 'Co-owner') DESC, x.created_at LIMIT 1) o ON true""";
    /** `q`: the unit number, or the name or phone of anyone living there now (a co-owner or tenant too). */
    static final String FILTER = """
         WHERE (CAST(:q AS text) IS NULL OR u.unit_no ILIKE :q ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM property.occupant x WHERE x.community_id = u.community_id AND x.unit_id = u.id AND x.to_date IS NULL
                           AND (x.full_name ILIKE :q ESCAPE '\\' OR (CAST(:qDigits AS text) IS NOT NULL AND x.phone_e164 LIKE :qDigits))))
           AND (CAST(:block AS uuid) IS NULL OR u.block_id = CAST(:block AS uuid))
           AND (CAST(:noBlock AS boolean) IS FALSE OR u.block_id IS NULL)
           AND (CAST(:occupancy AS text) IS NULL OR u.occupancy = :occupancy)
           AND (CAST(:type AS text) IS NULL OR lower(u.unit_type) = lower(:type))
           AND (CAST(:archived AS boolean) OR u.status = 'Active')""";
    /** Homes a block (and how they are lived in), in the blocks' own order; the units in no block come last. */
    static final String BY_BLOCK = """
        SELECT u.block_id, b.name AS block_name, count(*) AS total, count(*) FILTER (WHERE u.occupancy = 'Owner occupied') AS owner_occupied,
               count(*) FILTER (WHERE u.occupancy = 'Tenant occupied') AS tenant_occupied, count(*) FILTER (WHERE u.occupancy = 'Vacant') AS vacant
        FROM property.unit u LEFT JOIN property.block b ON b.community_id = u.community_id AND b.id = u.block_id
        WHERE u.status = 'Active' AND %s
        GROUP BY u.block_id, b.name, b.sort_order ORDER BY b.sort_order NULLS LAST, lower(b.name) NULLS LAST LIMIT 1000""";
    public static String byBlockSql(String scopeSql) { return BY_BLOCK.formatted(scopeSql); }
    static final String INDEX = """
        SELECT u.id, u.unit_no, u.block_id, b.name AS block_name FROM property.unit u LEFT JOIN property.block b ON b.community_id = u.community_id AND b.id = u.block_id
        WHERE %s ORDER BY length(u.unit_no), u.unit_no LIMIT 100000""";
    public static String indexSql(String scopeSql) { return INDEX.formatted(scopeSql); }
    /** One page: the page's units are picked (and counted) first, through the indexes; only those rows then read their block and contact. */
    public static String listSql(String scopeSql) {
        return "WITH page AS (SELECT u.id, count(*) OVER () AS total FROM property.unit u\n" + FILTER + "\n  AND " + scopeSql
            + "\n  ORDER BY length(u.unit_no), u.unit_no LIMIT :limit OFFSET :offset)\n"
            + COLUMNS + ", page.total\nFROM page JOIN property.unit u ON u.id = page.id\n" + JOINS + "\nORDER BY length(u.unit_no), u.unit_no";
    }
    public static String getSql(String scopeSql) { return COLUMNS + ", 1 AS total\nFROM property.unit u\n" + JOINS + "\nWHERE u.id = CAST(:id AS uuid) AND " + scopeSql; }
    static final String UPDATE = """
        UPDATE property.unit SET unit_no = :unitNo, unit_type = :type, occupancy = :occupancy, area_sqft = :area, maintenance_plan = :plan, sanctioned_kw = :kw, bill_to = :billTo,
               custom = CAST(:custom AS jsonb)
        WHERE id = CAST(:id AS uuid) AND version = :version""";
    static final String TYPES = "SELECT property_types FROM platform.community_settings";
    static final String HAS_TENANT = "SELECT EXISTS (SELECT 1 FROM property.occupant o WHERE o.unit_id = CAST(:id AS uuid) AND o.relation = 'Tenant' AND o.to_date IS NULL) AS t";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcUnitRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public Page<Unit> find(Spec<Unit> scope, Filter f, PageQuery page) {
        Map<String, Object> p = new HashMap<>(scope.params());
        p.put("q", f.q() == null || f.q().isBlank() ? null : Rows.like(f.q().strip()));
        String digits = f.q() == null ? "" : f.q().replaceAll("[^0-9]", "");
        p.put("qDigits", digits.length() >= 4 ? "%" + digits + "%" : null);
        p.put("type", f.type() == null || f.type().isBlank() ? null : f.type().strip()); p.put("noBlock", f.noBlock());
        p.put("block", f.block() == null ? null : f.block().toString()); p.put("occupancy", f.occupancy()); p.put("archived", f.includeArchived());
        p.put("limit", page.limit()); p.put("offset", page.offset());
        long[] total = {0};
        List<Unit> rows = jdbc.query(listSql(scope.sql()), p,
            (rs, i) -> { total[0] = rs.getLong("total"); return map(rs); });
        return new Page<>(rows, total[0], page.limit(), page.offset());
    }
    @Override public List<Entry> index(Spec<Unit> scope) {
        return jdbc.query(indexSql(scope.sql()), new HashMap<>(scope.params()), (rs, i) -> new Entry(Rows.uuid(rs, "id"), rs.getString("unit_no"), Rows.uuid(rs, "block_id"), rs.getString("block_name")));
    }
    @Override public List<BlockCount> countByBlock(Spec<Unit> scope) {
        return jdbc.query(byBlockSql(scope.sql()), new HashMap<>(scope.params()), (rs, i) -> new BlockCount(Rows.uuid(rs, "block_id"), rs.getString("block_name"),
            rs.getLong("total"), rs.getLong("owner_occupied"), rs.getLong("tenant_occupied"), rs.getLong("vacant")));
    }
    @Override public Optional<Unit> findById(UnitId id, Spec<Unit> scope) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString());
        return jdbc.query(getSql(scope.sql()), p, (rs, i) -> map(rs)).stream().findFirst();
    }
    @Override public boolean save(Unit u, long expectedVersion) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", u.id().toString()); p.put("version", expectedVersion); p.put("unitNo", u.unitNo()); p.put("type", u.unitType()); p.put("occupancy", u.occupancy()); p.put("area", u.areaSqft());
        p.put("plan", u.maintenancePlan()); p.put("kw", u.sanctionedKw()); p.put("billTo", u.billTo());
        try { p.put("custom", json.writeValueAsString(u.custom())); } catch (Exception e) { throw new IllegalStateException(e); }
        return jdbc.update(UPDATE, p) == 1;
    }
    @Override public Set<String> propertyTypes() {
        return jdbc.query(TYPES, Map.of(), (rs, i) -> Rows.set(rs, "property_types", String::valueOf)).stream().findFirst().orElse(Set.of("Villa", "Apartment"));
    }

    @Override public boolean hasTenant(UnitId id) { return Boolean.TRUE.equals(jdbc.queryForObject(HAS_TENANT, Map.of("id", id.toString()), Boolean.class)); }

    private Unit map(ResultSet rs) throws SQLException {
        Map<String, Object> custom;
        try { custom = json.readValue(rs.getString("custom"), new TypeReference<Map<String, Object>>() {}); } catch (java.io.IOException e) { throw new SQLException(e); }
        UUID block = Rows.uuid(rs, "block_id");
        return new Unit(new UnitId(Rows.uuid(rs, "id")), rs.getString("short_id"), rs.getString("unit_no"), block == null ? null : new BlockId(block), rs.getString("block_name"),
            rs.getString("unit_type"), rs.getString("occupancy"), rs.getBigDecimal("area_sqft"), rs.getString("maintenance_plan"), rs.getBigDecimal("sanctioned_kw"),
            rs.getString("status"), custom, Rows.instant(rs, "updated_at"), rs.getLong("version"))
            .contact(rs.getString("contact_name"), rs.getString("contact_phone"), rs.getString("contact_relation")).billing(rs.getString("bill_to"));
    }
}
