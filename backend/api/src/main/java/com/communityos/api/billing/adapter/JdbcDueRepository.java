package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.domain.ChargeCategory;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.billing.domain.DueStatus;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** billing.due on the tenant connection. Lists hit due_unit_status / due_status_date; settlement locks rows in id order (no deadlocks). */
public final class JdbcDueRepository implements DueRepository {
    static final String COLUMNS = """
        SELECT d.id, d.community_id, d.short_id, d.unit_id, u.block_id, u.unit_no, d.category_id, c.code AS category_code, c.name AS category_name, c.is_utility,
               c.tax_rate, c.income_account_id, c.active AS category_active, d.billed_month, d.description, d.amount, d.tax_amount, d.paid_amount, d.credit_applied,
               d.due_date, d.status, d.paid_at, d.cancel_reason, d.created_at, d.version""";
    static final String FROM = """
         FROM billing.due d
         JOIN billing.charge_category c ON c.community_id = d.community_id AND c.id = d.category_id
         LEFT JOIN property.unit u ON u.community_id = d.community_id AND u.id = d.unit_id""";
    static final String FILTER = """
         WHERE (CAST(:unit AS uuid) IS NULL OR d.unit_id = CAST(:unit AS uuid))
           AND (CAST(:status AS text) IS NULL OR d.status = :status)
           AND (CAST(:open AS boolean) IS FALSE OR d.status IN ('Unpaid', 'Partly paid'))
           AND (CAST(:monthFrom AS date) IS NULL OR d.billed_month >= CAST(:monthFrom AS date))
           AND (CAST(:monthTo AS date) IS NULL OR d.billed_month <= CAST(:monthTo AS date))
           AND (CAST(:category AS text) IS NULL OR c.code = :category)""";
    static final String LOCK_IDS = COLUMNS + "\n" + FROM + "\nWHERE d.id IN (:ids) ORDER BY d.id FOR UPDATE OF d";
    static final String LOCK_OPEN = COLUMNS + "\n" + FROM + "\nWHERE d.unit_id = CAST(:unit AS uuid) AND d.status IN ('Unpaid', 'Partly paid') ORDER BY d.id FOR UPDATE OF d";
    /** The list query for a caller's access specification (public so the SQL check composes exactly what runs). */
    public static String listSql(String scopeSql) { return COLUMNS + ", count(*) OVER () AS total\n" + FROM + "\n" + FILTER + "\n  AND " + scopeSql + "\nORDER BY d.due_date DESC, d.id LIMIT :limit OFFSET :offset"; }
    public static String getSql(String scopeSql) { return COLUMNS + "\n" + FROM + "\nWHERE d.id = CAST(:id AS uuid) AND " + scopeSql; }
    static final String INSERT = """
        INSERT INTO billing.due (community_id, id, unit_id, category_id, billed_month, description, amount, tax_amount, due_date)
        VALUES (CAST(:community AS uuid), CAST(:id AS uuid), CAST(:unit AS uuid), CAST(:category AS uuid), CAST(:month AS date), :description, :amount, :tax, CAST(:dueDate AS date))
        RETURNING short_id, version""";
    static final String UPDATE = """
        UPDATE billing.due SET paid_amount = :paid, status = :status, paid_at = CAST(:paidAt AS timestamptz), cancel_reason = :reason,
               cancelled_at = CASE WHEN CAST(:status AS text) IN ('Cancelled', 'Waived') THEN now() END
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcDueRepository(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public Page<Due> find(Spec<Due> scope, Filter f, PageQuery page) {
        Map<String, Object> p = new HashMap<>(scope.params());
        p.put("unit", f.unit() == null ? null : f.unit().toString()); p.put("status", f.status()); p.put("open", f.openOnly());
        p.put("monthFrom", Rows.sqlDate(f.monthFrom())); p.put("monthTo", Rows.sqlDate(f.monthTo())); p.put("category", f.categoryCode());
        p.put("limit", page.limit()); p.put("offset", page.offset());
        long[] total = {0};
        List<Due> rows = jdbc.query(listSql(scope.sql()), p, (rs, i) -> { total[0] = rs.getLong("total"); return map(rs); });
        return new Page<>(rows, total[0], page.limit(), page.offset());
    }
    @Override public Optional<Due> findById(DueId id, Spec<Due> scope) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString());
        return jdbc.query(getSql(scope.sql()), p, (rs, i) -> map(rs)).stream().findFirst();
    }
    @Override public List<Due> lockForSettlement(Collection<DueId> ids) {
        if (ids.isEmpty()) return List.of();
        List<Due> rows = jdbc.query(LOCK_IDS, Map.of("ids", ids.stream().map((d) -> d.value()).toList()), (rs, i) -> map(rs));
        return rows.stream().sorted(Comparator.comparing(Due::dueDate).thenComparing((Due d) -> d.id().value())).toList();
    }
    @Override public List<Due> lockOpenOfUnit(UnitId unit) {
        return jdbc.query(LOCK_OPEN, Map.of("unit", unit.toString()), (rs, i) -> map(rs)).stream()
            .sorted(Comparator.comparing(Due::dueDate).thenComparing((Due d) -> d.id().value())).toList();
    }
    @Override public void insert(Due d) {
        Map<String, Object> p = new HashMap<>();
        p.put("community", d.community().toString()); p.put("id", d.id().toString()); p.put("unit", d.unit() == null ? null : d.unit().toString());
        p.put("category", d.category().id().toString()); p.put("month", Rows.sqlDate(d.billedMonth())); p.put("description", d.description());
        p.put("amount", d.amount().amount()); p.put("tax", d.tax().amount()); p.put("dueDate", Rows.sqlDate(d.dueDate()));
        jdbc.query(INSERT, p, (rs, i) -> { d.numbered(rs.getString("short_id")); d.stored(rs.getLong("version")); return null; });
    }
    @Override public boolean save(Due d) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", d.id().toString()); p.put("version", d.version()); p.put("paid", d.paid().amount()); p.put("status", d.status().label());
        p.put("paidAt", Rows.ts(d.paidAt())); p.put("reason", d.cancelReason());
        List<Long> v = jdbc.query(UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        d.stored(v.get(0));
        return true;
    }

    static Due map(ResultSet rs) throws SQLException {
        UUID unit = Rows.uuid(rs, "unit_id"), block = Rows.uuid(rs, "block_id");
        ChargeCategory cat = new ChargeCategory(Rows.uuid(rs, "category_id"), rs.getString("category_code"), rs.getString("category_name"), rs.getBoolean("is_utility"),
            rs.getBigDecimal("tax_rate"), Rows.uuid(rs, "income_account_id"), rs.getBoolean("category_active"));
        return new Due(new DueId(Rows.uuid(rs, "id")), new CommunityId(Rows.uuid(rs, "community_id")), rs.getString("short_id"), unit == null ? null : new UnitId(unit),
            block == null ? null : new BlockId(block), rs.getString("unit_no"), cat, Rows.date(rs, "billed_month"), rs.getString("description"), Rows.money(rs, "amount"),
            Rows.money(rs, "tax_amount"), Rows.money(rs, "paid_amount"), Rows.money(rs, "credit_applied"), Rows.date(rs, "due_date"), DueStatus.of(rs.getString("status")),
            Rows.instant(rs, "paid_at"), rs.getString("cancel_reason"), Rows.instant(rs, "created_at"), rs.getLong("version"));
    }
}
