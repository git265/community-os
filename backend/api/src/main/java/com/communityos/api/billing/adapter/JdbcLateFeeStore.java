package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.LateFeeStore;
import com.communityos.api.billing.domain.LateFees;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Late fees on the tenant connection. */
public final class JdbcLateFeeStore implements LateFeeStore {
    static final String SETTINGS = """
        SELECT s.late_fee_enabled, s.late_fee_auto, s.late_fee_kind, s.late_fee_value, s.late_fee_grace_days, s.late_fee_max_months, s.late_fee_rules
        FROM finance.finance_setting s LIMIT 1""";
    static final String OVERDUE = """
        SELECT d.id, d.short_id, d.unit_id, c.code AS category, d.status, d.total, d.due_date, d.billed_month FROM billing.due d
        JOIN billing.charge_category c ON c.community_id = d.community_id AND c.id = d.category_id
        WHERE d.status IN ('Unpaid', 'Partly paid') AND d.due_date < current_date AND d.late_fee_for IS NULL AND d.unit_id IS NOT NULL
        ORDER BY d.due_date LIMIT 20000""";
    static final String CHARGED = "SELECT d.late_fee_for, d.late_fee_no FROM billing.due d WHERE d.late_fee_for IS NOT NULL AND d.status <> 'Cancelled'";
    static final String TIE = "UPDATE billing.due SET late_fee_for = CAST(:for AS uuid), late_fee_no = :no WHERE id = CAST(:id AS uuid) AND late_fee_for IS NULL";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcLateFeeStore(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public LateFees.Settings settings() {
        return jdbc.query(SETTINGS, Map.of(), (rs, i) -> LateFees.settings(rs.getBoolean("late_fee_enabled"), rs.getBoolean("late_fee_auto"), rs.getString("late_fee_kind"),
            rs.getBigDecimal("late_fee_value"), rs.getBigDecimal("late_fee_grace_days"), rs.getBigDecimal("late_fee_max_months"), rs.getString("late_fee_rules"), json))
            .stream().findFirst().orElse(new LateFees.Settings(false, false, List.of()));
    }
    @Override public List<LateFees.Bill> overdue() {
        return jdbc.query(OVERDUE, Map.of(), (rs, i) -> new LateFees.Bill(Rows.uuid(rs, "id"), rs.getString("short_id"), Rows.uuid(rs, "unit_id"), rs.getString("category"), rs.getString("status"),
            rs.getBigDecimal("total"), Rows.date(rs, "due_date"), Rows.date(rs, "billed_month")));
    }
    @Override public Set<String> charged() {
        Set<String> out = new HashSet<>();
        jdbc.query(CHARGED, Map.of(), (rs, i) -> out.add(Rows.uuid(rs, "late_fee_for") + "#" + rs.getInt("late_fee_no")));
        return out;
    }
    @Override public boolean tie(UUID feeBillId, UUID forBillId, int no) {
        try { return jdbc.update(TIE, Map.of("id", feeBillId.toString(), "for", forBillId.toString(), "no", no)) == 1; }
        catch (DuplicateKeyException e) { return false; }
    }
}
