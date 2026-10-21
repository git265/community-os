package com.communityos.api.approval.adapter;

import com.communityos.api.approval.application.ApprovalSettings;
import com.communityos.api.approval.application.Approvers;
import com.communityos.api.approval.domain.Plan;
import com.communityos.api.approval.domain.Policy;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Reads finance.approval_policy, maintenance.approver_setting and finance.finance_setting of the caller's community (tenant connection). */
public final class JdbcApprovalSettings implements ApprovalSettings {
    static final String POLICIES = "SELECT name, active, priority, subjects, min_amount, max_amount, categories, task_types, require_flag, steps FROM finance.approval_policy ORDER BY priority NULLS LAST, name";
    static final String FINAL_ROLES = "SELECT roles FROM maintenance.approver_setting WHERE name = 'Final approval'";
    static final String SETTINGS = "SELECT final_can_decide_ec, approval_separate, invoice_tolerance_pct, invoice_skip_within_quote FROM finance.finance_setting ORDER BY created_at LIMIT 1";
    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcApprovalSettings(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public List<Policy> policies() {
        return jdbc.query(POLICIES, Map.of(), (rs, i) -> new Policy(rs.getString("name"), rs.getBoolean("active"), rs.getBigDecimal("priority") == null ? 100 : rs.getBigDecimal("priority").intValue(),
            Rows.list(rs, "subjects", String::valueOf), rs.getBigDecimal("min_amount"), rs.getBigDecimal("max_amount"), Rows.list(rs, "categories", String::valueOf),
            Rows.list(rs, "task_types", String::valueOf), rs.getString("require_flag"), steps(rs.getString("steps"))));
    }
    @Override public Settings settings() {
        Set<String> roles = new HashSet<>();
        jdbc.query(FINAL_ROLES, Map.of(), (rs, i) -> roles.addAll(Rows.list(rs, "roles", String::valueOf)));
        List<Settings> s = jdbc.query(SETTINGS, Map.of(), (rs, i) -> new Settings(new Approvers(roles, rs.getBoolean("final_can_decide_ec"), rs.getBoolean("approval_separate")),
            rs.getBigDecimal("invoice_tolerance_pct") == null ? BigDecimal.ZERO : rs.getBigDecimal("invoice_tolerance_pct"), rs.getBoolean("invoice_skip_within_quote")));
        return s.isEmpty() ? new Settings(new Approvers(roles, false, false), BigDecimal.ZERO, false) : s.get(0);
    }

    /** steps as the rules screen writes them: [{name, approvers:[{kind,value}], needed, canFinish, deadlineDays}] */
    List<Plan.Step> steps(String text) {
        if (text == null || text.isBlank()) return List.of();
        try {
            JsonNode a = json.readTree(text); List<Plan.Step> out = new ArrayList<>();
            if (!a.isArray()) return List.of();
            for (JsonNode s : a) {
                List<Plan.Approver> who = new ArrayList<>();
                for (JsonNode x : s.path("approvers")) who.add(new Plan.Approver(x.path("kind").asText(), x.path("value").asText()));
                out.add(new Plan.Step("s" + (out.size() + 1), s.path("name").asText("Approval"), who, s.path("needed").asInt(1), s.path("canFinish").asBoolean(false), s.path("deadlineDays").asInt(0), false, List.of()));
            }
            return out;
        } catch (Exception e) { return List.of(); }
    }
}
