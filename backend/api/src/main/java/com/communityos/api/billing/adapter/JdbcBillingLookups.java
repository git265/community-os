package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.ChargeCategories;
import com.communityos.api.billing.application.port.UnitLookup;
import com.communityos.api.billing.domain.ChargeCategory;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Charge categories and the unit lookup billing needs (tenant connection). */
public final class JdbcBillingLookups implements ChargeCategories, UnitLookup {
    static final String CATEGORY = "SELECT id, code, name, is_utility, tax_rate, income_account_id, active FROM billing.charge_category WHERE code = :code";
    static final String UNIT = "SELECT id, block_id, unit_no, status FROM property.unit WHERE id = CAST(:id AS uuid)";
    private final NamedParameterJdbcTemplate jdbc;
    public JdbcBillingLookups(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public Optional<ChargeCategory> byCode(String code) {
        return jdbc.query(CATEGORY, Map.of("code", code), (rs, i) -> new ChargeCategory(Rows.uuid(rs, "id"), rs.getString("code"), rs.getString("name"), rs.getBoolean("is_utility"),
            rs.getBigDecimal("tax_rate"), Rows.uuid(rs, "income_account_id"), rs.getBoolean("active"))).stream().findFirst();
    }
    @Override public Optional<UnitRef> find(UnitId id) {
        return jdbc.query(UNIT, Map.of("id", id.toString()), (rs, i) -> {
            UUID b = Rows.uuid(rs, "block_id");
            return new UnitRef(new UnitId(Rows.uuid(rs, "id")), b == null ? null : new BlockId(b), rs.getString("unit_no"), "Active".equals(rs.getString("status")));
        }).stream().findFirst();
    }
}
