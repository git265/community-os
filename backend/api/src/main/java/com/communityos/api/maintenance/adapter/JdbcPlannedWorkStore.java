package com.communityos.api.maintenance.adapter;

import com.communityos.api.maintenance.application.port.PlannedWorkStore;
import com.communityos.api.shared.jdbc.Rows;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** maintenance.checklist / checklist_round / checklist_alert on the tenant connection. */
public final class JdbcPlannedWorkStore implements PlannedWorkStore {
    static final String ACTIVE = """
        SELECT id, name, area, frequency, due_day, due_month, starts_on, assignee_role, assignee_id FROM maintenance.checklist WHERE active ORDER BY lower(name) LIMIT 500""";
    static final String DONE = "SELECT 1 AS x FROM maintenance.checklist_round WHERE checklist_id = CAST(:id AS uuid) AND period = :p AND status = 'Done'";
    static final String CLAIM = """
        INSERT INTO maintenance.checklist_alert (community_id, checklist_id, period, kind) VALUES (platform.current_community(), CAST(:id AS uuid), :p, :k)
        ON CONFLICT DO NOTHING RETURNING checklist_id""";
    private final NamedParameterJdbcTemplate jdbc;
    public JdbcPlannedWorkStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public List<Active> active() {
        return jdbc.query(ACTIVE, Map.of(), (rs, i) -> new Active(Rows.uuid(rs, "id"), rs.getString("name"), rs.getString("area"), rs.getString("frequency"),
            rs.getObject("due_day") == null ? null : rs.getInt("due_day"), rs.getObject("due_month") == null ? null : rs.getInt("due_month"), Rows.date(rs, "starts_on"),
            rs.getString("assignee_role"), Rows.uuid(rs, "assignee_id")));
    }
    @Override public boolean done(UUID checklistId, String period) { return !jdbc.query(DONE, Map.of("id", checklistId.toString(), "p", period), (rs, i) -> 1).isEmpty(); }
    @Override public boolean claim(UUID checklistId, String period, String kind) {
        return !jdbc.query(CLAIM, Map.of("id", checklistId.toString(), "p", period, "k", kind), (rs, i) -> 1).isEmpty();
    }
}
