package com.communityos.api.amenity.adapter;

import com.communityos.api.amenity.application.port.AmenityCatalog;
import com.communityos.api.amenity.domain.AmenityType;
import com.communityos.api.amenity.domain.Pricing;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** What the booking rules read, on the tenant connection. */
public final class JdbcAmenityCatalog implements AmenityCatalog {
    static final String TYPE_COLUMNS = """
        SELECT t.id, t.name, t.active, t.rate, t.rate_unit, t.weekend_rate, t.gst_applicable, t.gst_rate, t.gst_mode, t.deposit_amount, t.cancellation_rules::text AS tiers,
               t.min_notice_hours, t.max_advance_days, t.capacity, t.hours, t.booking_mode, t.reservation, t.override_roles, t.max_per_day, t.max_per_month, t.max_upcoming,
               t.blackout_dates, t.allowed_unit_types, t.slots
        FROM amenity.amenity_type t""";
    static final String TYPE = TYPE_COLUMNS + " WHERE t.id = CAST(:id AS uuid)";
    static final String LOCK_TYPE = TYPE_COLUMNS + " WHERE t.id = CAST(:id AS uuid) FOR UPDATE";
    static final String ITEMS = "SELECT i.id, i.name, i.amenity_type_id, i.stock, i.price, i.max_per_booking, i.active FROM amenity.item i ORDER BY i.name";
    static final String SETTINGS = "SELECT s.default_gst_rate, s.refund_mode, s.payment_due_hours FROM amenity.setting s ORDER BY s.created_at LIMIT 1";
    static final String UNIT = "SELECT u.id, u.unit_no, u.unit_type, u.block_id FROM property.unit u WHERE u.id = CAST(:id AS uuid)";
    static final String DEFAULTER = """
        SELECT f.block_overdue_amount AS limit_amount, coalesce(sum(d.total - d.paid_amount - d.credit_applied), 0) AS overdue
        FROM finance.finance_setting f
        LEFT JOIN billing.due d ON d.community_id = f.community_id AND d.unit_id = CAST(:unit AS uuid) AND d.status IN ('Unpaid', 'Partly paid')
             AND d.due_date < CAST(:today AS date) - make_interval(days => coalesce(f.block_overdue_days, 0)::int)
        WHERE f.block_defaulters
        GROUP BY f.block_overdue_amount""";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcAmenityCatalog(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public Optional<AmenityType> lockType(UUID id) { return jdbc.query(LOCK_TYPE, Map.of("id", id.toString()), (rs, i) -> type(rs)).stream().findFirst(); }
    @Override public Optional<AmenityType> type(UUID id) { return jdbc.query(TYPE, Map.of("id", id.toString()), (rs, i) -> type(rs)).stream().findFirst(); }
    @Override public List<Pricing.Item> items() {
        return jdbc.query(ITEMS, Map.of(), (rs, i) -> new Pricing.Item(Rows.uuid(rs, "id"), rs.getString("name"), Rows.uuid(rs, "amenity_type_id"), rs.getBigDecimal("stock"),
            rs.getBigDecimal("price"), rs.getBigDecimal("max_per_booking"), rs.getBoolean("active")));
    }
    @Override public Settings settings() {
        List<Settings> s = jdbc.query(SETTINGS, Map.of(), (rs, i) -> new Settings(rs.getBigDecimal("default_gst_rate"), "Credit to unit account".equals(rs.getString("refund_mode")),
            rs.getBigDecimal("payment_due_hours") == null ? 24 : rs.getBigDecimal("payment_due_hours").intValue()));
        return s.isEmpty() ? new Settings(BigDecimal.valueOf(18), false, 24) : s.get(0);
    }
    @Override public Optional<UnitInfo> unit(UnitId unit) {
        return jdbc.query(UNIT, Map.of("id", unit.toString()), (rs, i) -> { UUID b = Rows.uuid(rs, "block_id");
            return new UnitInfo(new UnitId(Rows.uuid(rs, "id")), rs.getString("unit_no"), rs.getString("unit_type"), b == null ? null : new BlockId(b)); }).stream().findFirst();
    }
    @Override public String defaulterHold(UnitId unit, LocalDate today) {
        return jdbc.query(DEFAULTER, Map.of("unit", unit.toString(), "today", Rows.sqlDate(today)), (rs, i) -> {
            BigDecimal overdue = rs.getBigDecimal("overdue"), limit = rs.getBigDecimal("limit_amount");
            return overdue != null && overdue.signum() > 0 && (limit == null || overdue.compareTo(limit) > 0)
                ? "This unit has " + overdue.toPlainString() + " of overdue dues - clear them to book amenities" : null;
        }).stream().filter(java.util.Objects::nonNull).findFirst().orElse(null);
    }

    private AmenityType type(ResultSet rs) throws SQLException {
        List<AmenityType.Tier> tiers;
        String t = rs.getString("tiers");
        try { tiers = t == null ? List.of() : json.readValue(t, new TypeReference<List<AmenityType.Tier>>() {}); } catch (java.io.IOException e) { tiers = List.of(); }
        BigDecimal minH = rs.getBigDecimal("min_notice_hours"), maxD = rs.getBigDecimal("max_advance_days");
        return new AmenityType(Rows.uuid(rs, "id"), rs.getString("name"), rs.getBoolean("active"), rs.getBigDecimal("rate"), rs.getString("rate_unit"), rs.getBigDecimal("weekend_rate"),
            rs.getBoolean("gst_applicable"), rs.getBigDecimal("gst_rate"), rs.getString("gst_mode"), rs.getBigDecimal("deposit_amount"), tiers,
            minH == null ? null : minH.intValue(), maxD == null ? null : maxD.intValue(), rs.getInt("capacity"), rs.getString("hours"), rs.getString("booking_mode"), rs.getString("reservation"),
            Rows.list(rs, "override_roles", String::valueOf), rs.getBigDecimal("max_per_day"), rs.getBigDecimal("max_per_month"), rs.getBigDecimal("max_upcoming"),
            Rows.list(rs, "blackout_dates", String::valueOf), Rows.list(rs, "allowed_unit_types", String::valueOf), Rows.list(rs, "slots", String::valueOf));
    }
}
