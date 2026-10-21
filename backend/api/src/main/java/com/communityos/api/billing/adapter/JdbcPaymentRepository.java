package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.domain.BillingEvents.Allocation;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.domain.Ids.PaymentId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.jdbc.Rows;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** billing.payment, payment_allocation and unit_credit (tenant connection). The API role cannot delete payments at all. */
public final class JdbcPaymentRepository implements PaymentRepository {
    static final String COLUMNS = """
        SELECT p.id, p.short_id, p.unit_id, p.order_id, p.amount, p.method, p.provider, p.received_at,
               ARRAY(SELECT a.due_id::text || '=' || a.amount::text FROM billing.payment_allocation a WHERE a.community_id = p.community_id AND a.payment_id = p.id ORDER BY a.due_id) AS allocations,
               COALESCE((SELECT sum(c.amount) FROM billing.unit_credit c WHERE c.community_id = p.community_id AND c.source_type = 'overpayment' AND c.source_id = p.id), 0) AS credited
        FROM billing.payment p""";
    static final String BY_REF = COLUMNS + " WHERE p.provider = :provider AND p.provider_payment_ref = :ref";
    static final String BY_ID = COLUMNS + " WHERE p.id = CAST(:id AS uuid)";
    static final String INSERT = """
        INSERT INTO billing.payment (community_id, id, order_id, unit_id, amount, method, provider, provider_payment_ref, received_at, note)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:order AS uuid), CAST(:unit AS uuid), :amount, :method, :provider, :ref, CAST(:at AS timestamptz), :note)
        RETURNING short_id""";
    static final String ALLOCATE = """
        INSERT INTO billing.payment_allocation (community_id, payment_id, due_id, amount) VALUES (platform.current_community(), CAST(:payment AS uuid), CAST(:due AS uuid), :amount)""";
    static final String CREDIT = """
        INSERT INTO billing.unit_credit (community_id, unit_id, amount, reason, source_type, source_id)
        VALUES (platform.current_community(), CAST(:unit AS uuid), :amount, :reason, 'overpayment', CAST(:source AS uuid))""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcPaymentRepository(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public Optional<Receipt> findByProviderRef(String provider, String ref) {
        if (provider == null || ref == null) return Optional.empty();
        return jdbc.query(BY_REF, Map.of("provider", provider, "ref", ref), (rs, i) -> map(rs)).stream().findFirst();
    }
    @Override public Optional<Receipt> findById(PaymentId id) { return jdbc.query(BY_ID, Map.of("id", id.toString()), (rs, i) -> map(rs)).stream().findFirst(); }
    @Override public String insert(NewPayment n) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", n.id().toString()); p.put("order", n.order() == null ? null : n.order().toString()); p.put("unit", n.unit().toString()); p.put("amount", n.amount().amount());
        p.put("method", n.method()); p.put("provider", n.provider()); p.put("ref", n.providerRef()); p.put("at", Rows.ts(n.receivedAt())); p.put("note", n.note());
        try { return jdbc.queryForObject(INSERT, p, String.class); }
        catch (DuplicateKeyException e) { throw new AlreadyRecorded(); }
    }
    @Override public void allocate(PaymentId payment, List<Allocation> allocations) {
        for (Allocation a : allocations) jdbc.update(ALLOCATE, Map.of("payment", payment.toString(), "due", a.dueId().toString(), "amount", a.amount().amount()));
    }
    @Override public void creditUnit(UnitId unit, Money amount, PaymentId source, String reason) {
        jdbc.update(CREDIT, Map.of("unit", unit.toString(), "amount", amount.amount(), "reason", reason, "source", source.toString()));
    }

    private static Receipt map(ResultSet rs) throws SQLException {
        List<Allocation> al = new ArrayList<>();
        for (String s : Rows.list(rs, "allocations", String::valueOf)) { String[] kv = s.split("="); al.add(new Allocation(new DueId(UUID.fromString(kv[0])), new Money(new BigDecimal(kv[1])))); }
        UUID order = Rows.uuid(rs, "order_id");
        return new Receipt(new PaymentId(Rows.uuid(rs, "id")), rs.getString("short_id"), new UnitId(Rows.uuid(rs, "unit_id")), order == null ? null : new OrderId(order),
            Rows.money(rs, "amount"), rs.getString("method"), rs.getString("provider"), Rows.instant(rs, "received_at"), al, Rows.money(rs, "credited"));
    }
}
