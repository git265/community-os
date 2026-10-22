package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.ReadingStore;
import com.communityos.api.shared.jdbc.Rows;
import java.time.LocalDate;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Meter readings, their rate cards and photos for publishing (tenant connection). */
public final class JdbcReadingStore implements ReadingStore {
    static final String LOCK = """
        SELECT r.id, r.short_id, r.unit_id, r.utility, r.month, r.previous_reading, r.current_reading, r.units_consumed, r.status, r.version
        FROM billing.meter_reading r WHERE r.id = CAST(:id AS uuid) FOR UPDATE""";
    static final String RATE = "SELECT c.rate_per_unit, c.fixed_charge, c.tax FROM billing.utility_rate_card c WHERE lower(c.type) = lower(:utility)";
    static final String UNIT_NAME = "SELECT t.unit_name FROM billing.utility_type t WHERE lower(t.name) = lower(:utility)";
    static final String PHOTOS = "SELECT count(*) AS n FROM docs.file_object f WHERE f.owner_type = 'billing.reading' AND f.owner_id = CAST(:id AS uuid) AND f.scan_status <> 'Infected'";
    static final String PUBLISHED = """
        UPDATE billing.meter_reading SET status = 'Published', due_id = CAST(:due AS uuid), published_at = CAST(:on AS date)
        WHERE id = CAST(:id AS uuid) AND version = :version AND coalesce(status, 'Draft') = 'Draft'""";
    static final String LINK = "UPDATE billing.due SET reading_id = CAST(:reading AS uuid) WHERE id = CAST(:due AS uuid) AND reading_id IS NULL";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcReadingStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public Optional<Draft> lock(UUID id) {
        return jdbc.query(LOCK, Map.of("id", id.toString()), (rs, i) -> new Draft(Rows.uuid(rs, "id"), rs.getString("short_id"), Rows.uuid(rs, "unit_id"), rs.getString("utility"), rs.getString("month"),
            rs.getBigDecimal("previous_reading"), rs.getBigDecimal("current_reading"), rs.getBigDecimal("units_consumed"), rs.getString("status"), rs.getLong("version"))).stream().findFirst();
    }
    @Override public Optional<RateCard> rateCard(String utility) {
        return jdbc.query(RATE, Map.of("utility", utility), (rs, i) -> new RateCard(rs.getBigDecimal("rate_per_unit"), rs.getBigDecimal("fixed_charge"), rs.getBigDecimal("tax"))).stream().findFirst();
    }
    @Override public String unitName(String utility) { return jdbc.query(UNIT_NAME, Map.of("utility", utility), (rs, i) -> rs.getString("unit_name")).stream().filter(java.util.Objects::nonNull).findFirst().orElse("units"); }
    @Override public int photos(UUID readingId) { return jdbc.query(PHOTOS, Map.of("id", readingId.toString()), (rs, i) -> rs.getInt("n")).get(0); }
    @Override public boolean published(UUID id, long version, UUID dueId, LocalDate on) {
        return jdbc.update(PUBLISHED, Map.of("id", id.toString(), "version", version, "due", dueId.toString(), "on", on.toString())) == 1;
    }
    @Override public void linkBill(UUID dueId, UUID readingId) { jdbc.update(LINK, Map.of("due", dueId.toString(), "reading", readingId.toString())); }
}
