package com.communityos.api.demo;

import com.communityos.api.shared.domain.Ids.CommunityId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The blocks and units the sample data names, made the way the community's set-up makes them (the platform connection, as seed.sql does). */
public final class PlatformSetup implements DemoData.Setup {
    static final String BLOCK = "INSERT INTO property.block (community_id, name, kind) VALUES (CAST(:c AS uuid), :name, :kind) ON CONFLICT (community_id, name) DO NOTHING";
    static final String UNIT = """
        INSERT INTO property.unit (community_id, unit_no, unit_type, block_id)
        VALUES (CAST(:c AS uuid), :unit, :type, (SELECT b.id FROM property.block b WHERE b.community_id = CAST(:c AS uuid) AND b.name = :block))
        ON CONFLICT (community_id, unit_no) DO UPDATE SET block_id = coalesce(property.unit.block_id, EXCLUDED.block_id)""";
    private final NamedParameterJdbcTemplate platform;
    public PlatformSetup(NamedParameterJdbcTemplate platform) { this.platform = platform; }

    @Override public void units(CommunityId community, List<DemoData.BlockSpec> blocks, List<DemoData.UnitSpec> units) {
        for (DemoData.BlockSpec b : blocks) platform.update(BLOCK, Map.of("c", community.toString(), "name", b.name(), "kind", b.kind()));
        for (DemoData.UnitSpec u : units) {
            Map<String, Object> p = new HashMap<>();
            p.put("c", community.toString()); p.put("unit", u.unitNo()); p.put("type", u.unitType()); p.put("block", u.block());
            platform.update(UNIT, p);
        }
    }
}
