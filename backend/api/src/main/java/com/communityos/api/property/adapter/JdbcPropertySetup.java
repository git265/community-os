package com.communityos.api.property.adapter;

import com.communityos.api.property.application.port.PropertySetup;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** property.block / property.unit_setting / new property.unit rows on the tenant connection (the community comes from the connection). */
public final class JdbcPropertySetup implements PropertySetup {
    /** The community directory: one row a unit, its contact from the current occupants (never past ones, never family or caretakers). */
    static final String DIRECTORY = """
        SELECT u.id, u.unit_no, b.name AS block_name, u.unit_type, o.full_name, o.phone_e164, o.relation, count(*) OVER () AS total
        FROM property.unit u
        LEFT JOIN property.block b ON b.community_id = u.community_id AND b.id = u.block_id
        LEFT JOIN LATERAL (
          SELECT x.full_name, x.phone_e164, x.relation FROM property.occupant x
          WHERE x.community_id = u.community_id AND x.unit_id = u.id AND x.to_date IS NULL AND x.relation IN ('Owner', 'Co-owner', 'Tenant')
          ORDER BY (x.relation = 'Owner' AND x.is_primary) DESC, (x.relation = 'Owner') DESC, (x.relation = 'Co-owner') DESC, x.created_at LIMIT 1) o ON true
        WHERE u.status = 'Active'
          AND (CAST(:q AS text) IS NULL OR u.unit_no ILIKE :q ESCAPE '\\' OR o.full_name ILIKE :q ESCAPE '\\')
          AND (CAST(:type AS text) IS NULL OR u.unit_type = :type)
        ORDER BY lower(u.unit_no), u.id LIMIT :limit OFFSET :offset""";
    static final String BLOCKS = """
        SELECT b.id, b.short_id, b.name, b.code, b.kind, b.sort_order, b.unit_pattern, b.custom::text AS custom, b.version,
               (SELECT count(*) FROM property.unit u WHERE u.community_id = b.community_id AND u.block_id = b.id) AS units
        FROM property.block b ORDER BY b.sort_order, lower(b.name) LIMIT 500""";
    static final String BLOCK = """
        SELECT b.id, b.short_id, b.name, b.code, b.kind, b.sort_order, b.unit_pattern, b.custom::text AS custom, b.version,
               (SELECT count(*) FROM property.unit u WHERE u.community_id = b.community_id AND u.block_id = b.id) AS units
        FROM property.block b WHERE b.id = CAST(:id AS uuid)""";
    static final String INSERT_BLOCK = """
        INSERT INTO property.block (community_id, name, code, kind, sort_order, unit_pattern, custom)
        VALUES (platform.current_community(), :name, :code, :kind, :sort, :pattern, CAST(:custom AS jsonb)) RETURNING id""";
    static final String UPDATE_BLOCK = """
        UPDATE property.block SET name = :name, code = :code, kind = :kind, sort_order = :sort, unit_pattern = :pattern, custom = CAST(:custom AS jsonb)
        WHERE id = CAST(:id AS uuid) AND version = :version""";
    static final String DELETE_BLOCK = """
        DELETE FROM property.block b WHERE b.id = CAST(:id AS uuid) AND b.version = :version
          AND NOT EXISTS (SELECT 1 FROM property.unit u WHERE u.community_id = b.community_id AND u.block_id = b.id)""";
    static final String SETTING = "SELECT unit_pattern, version FROM property.unit_setting";
    static final String INSERT_SETTING = "INSERT INTO property.unit_setting (community_id, unit_pattern) VALUES (platform.current_community(), :pattern) ON CONFLICT (community_id) DO NOTHING";
    static final String UPDATE_SETTING = "UPDATE property.unit_setting SET unit_pattern = :pattern WHERE version = :version";
    static final String KEYS = "SELECT lower(unit_no) AS k FROM property.unit";
    static final String TAKEN = "SELECT count(*) FROM property.unit WHERE lower(unit_no) = lower(:no) AND (CAST(:except AS uuid) IS NULL OR id <> CAST(:except AS uuid))";
    static final String INSERT_UNITS = """
        INSERT INTO property.unit (community_id, unit_no, block_id, unit_type, occupancy, area_sqft)
        SELECT platform.current_community(), r.unit_no, r.block_id, r.unit_type, coalesce(r.occupancy, 'Vacant'), r.area_sqft
        FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(unit_no text, block_id uuid, unit_type text, occupancy text, area_sqft numeric)
        RETURNING id, short_id, unit_no""";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcPropertySetup(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    private Block block(java.sql.ResultSet rs) throws java.sql.SQLException {
        Map<String, Object> custom;
        try { custom = json.readValue(rs.getString("custom") == null ? "{}" : rs.getString("custom"), new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {}); }
        catch (Exception e) { custom = Map.of(); }
        return new Block(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("name"), rs.getString("code"), rs.getString("kind"), rs.getInt("sort_order"),
            rs.getString("unit_pattern"), custom, rs.getLong("units"), rs.getLong("version"));
    }
    @Override public List<Block> blocks() { return jdbc.query(BLOCKS, Map.of(), (rs, i) -> block(rs)); }
    @Override public Optional<Block> block(UUID id) { return jdbc.query(BLOCK, Map.of("id", id.toString()), (rs, i) -> block(rs)).stream().findFirst(); }
    private Map<String, Object> fields(BlockFields f) {
        Map<String, Object> p = new HashMap<>();
        p.put("name", f.name()); p.put("code", f.code()); p.put("kind", f.kind() == null ? "Block" : f.kind()); p.put("sort", f.sortOrder() == null ? 0 : f.sortOrder());
        p.put("pattern", f.unitPattern());
        try { p.put("custom", json.writeValueAsString(f.custom() == null ? Map.of() : f.custom())); } catch (Exception e) { throw new IllegalStateException(e); }
        return p;
    }
    @Override public UUID insertBlock(BlockFields f) { return jdbc.query(INSERT_BLOCK, fields(f), (rs, i) -> Rows.uuid(rs, "id")).get(0); }
    @Override public boolean updateBlock(UUID id, long version, BlockFields f) {
        Map<String, Object> p = fields(f); p.put("id", id.toString()); p.put("version", version);
        return jdbc.update(UPDATE_BLOCK, p) == 1;
    }
    @Override public boolean deleteBlock(UUID id, long version) { return jdbc.update(DELETE_BLOCK, Map.of("id", id.toString(), "version", version)) == 1; }

    @Override public Setting setting() {
        return jdbc.query(SETTING, Map.of(), (rs, i) -> new Setting(rs.getString("unit_pattern"), rs.getLong("version"))).stream().findFirst().orElse(new Setting(null, 0));
    }
    @Override public boolean saveSetting(String pattern, long version) {
        Map<String, Object> p = new HashMap<>(); p.put("pattern", pattern); p.put("version", version);
        if (version == 0) return jdbc.update(INSERT_SETTING, p) == 1;
        return jdbc.update(UPDATE_SETTING, p) == 1;
    }

    @Override public Set<String> unitKeys() { return new HashSet<>(jdbc.query(KEYS, Map.of(), (rs, i) -> rs.getString("k"))); }
    @Override public boolean numberTaken(String unitNo, UUID except) {
        Map<String, Object> p = new HashMap<>(); p.put("no", unitNo); p.put("except", except == null ? null : except.toString());
        Long n = jdbc.queryForObject(TAKEN, p, Long.class);
        return n != null && n > 0;
    }
    @Override public List<Added> insertUnits(List<NewUnit> units) {
        if (units.isEmpty()) return List.of();
        List<Map<String, Object>> rows = new ArrayList<>();
        for (NewUnit u : units) {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("unit_no", u.unitNo()); r.put("block_id", u.blockId() == null ? null : u.blockId().toString()); r.put("unit_type", u.unitType());
            r.put("occupancy", u.occupancy()); r.put("area_sqft", u.areaSqft());
            rows.add(r);
        }
        String body;
        try { body = json.writeValueAsString(rows); } catch (Exception e) { throw new IllegalStateException(e); }
        return jdbc.query(INSERT_UNITS, Map.of("rows", body), (rs, i) -> new Added(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("unit_no")));
    }

    @Override public com.communityos.api.shared.web.Page<DirectoryEntry> directory(String q, String type, int limit, int offset) {
        Map<String, Object> p = new HashMap<>();
        p.put("q", q == null || q.isBlank() ? null : Rows.like(q.strip())); p.put("type", type == null || type.isBlank() ? null : type.strip());
        p.put("limit", limit); p.put("offset", offset);
        long[] total = {0};
        List<DirectoryEntry> rows = jdbc.query(DIRECTORY, p, (rs, i) -> {
            total[0] = rs.getLong("total");
            return new DirectoryEntry(rs.getObject("id", UUID.class), rs.getString("unit_no"), rs.getString("block_name"), rs.getString("unit_type"),
                rs.getString("full_name"), rs.getString("phone_e164"), rs.getString("relation"));
        });
        return new com.communityos.api.shared.web.Page<>(rows, total[0], limit, offset);
    }
}
