package com.communityos.api.finance.adapter;

import com.communityos.api.finance.application.port.PayoutStore;
import com.communityos.api.shared.jdbc.Rows;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Online payments and the payouts they went into (tenant connection). */
public final class JdbcPayoutStore implements PayoutStore {
    static final String COLS = "SELECT p.id, p.short_id, p.provider, p.amount - p.refunded_amount AS amount, p.received_at FROM billing.payment p";
    static final String UNSETTLED = COLS + """

        WHERE p.provider IS NOT NULL AND p.payout_entry_id IS NULL AND p.status IN ('Captured', 'Partly refunded')
          AND p.received_at < CAST(:upTo AS date) + 1 ORDER BY p.received_at LIMIT 2000""";
    static final String LOCK = COLS + "\nWHERE p.id = ANY (CAST(:ids AS uuid[])) AND p.provider IS NOT NULL AND p.payout_entry_id IS NULL ORDER BY p.received_at FOR UPDATE OF p";
    static final String SETTLED = "UPDATE billing.payment SET payout_entry_id = CAST(:entry AS uuid) WHERE id = ANY (CAST(:ids AS uuid[])) AND payout_entry_id IS NULL";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcPayoutStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public List<OnlinePayment> unsettled(LocalDate upTo) { return jdbc.query(UNSETTLED, Map.of("upTo", upTo.toString()), (rs, i) -> row(rs)); }
    @Override public List<OnlinePayment> lock(Collection<UUID> ids) { return jdbc.query(LOCK, Map.of("ids", Rows.pgArray(ids)), (rs, i) -> row(rs)); }
    @Override public void settled(Collection<UUID> ids, UUID entryId) { jdbc.update(SETTLED, Map.of("ids", Rows.pgArray(ids), "entry", entryId.toString())); }
    static OnlinePayment row(ResultSet rs) throws SQLException {
        return new OnlinePayment(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("provider"), rs.getBigDecimal("amount"), Rows.instant(rs, "received_at"));
    }
}
