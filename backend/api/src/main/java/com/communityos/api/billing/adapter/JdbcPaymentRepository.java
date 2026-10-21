package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.domain.BillingEvents.Allocation;
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
               ARRAY(SELECT a.target_type || ':' || a.target_id::text || '=' || a.amount::text FROM billing.payment_allocation a
                      WHERE a.community_id = p.community_id AND a.payment_id = p.id ORDER BY a.target_type, a.target_id) AS allocations,
               COALESCE((SELECT sum(c.amount) FROM billing.unit_credit c WHERE c.community_id = p.community_id AND c.source_type IN ('overpayment', 'prepayment') AND c.source_id = p.id), 0) AS credited
        FROM billing.payment p""";
    static final String BY_REF = COLUMNS + " WHERE p.provider = :provider AND p.provider_payment_ref = :ref";
    static final String BY_ID = COLUMNS + " WHERE p.id = CAST(:id AS uuid)";
    static final String INSERT = """
        INSERT INTO billing.payment (community_id, id, order_id, unit_id, amount, method, provider, provider_payment_ref, received_at, note)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:order AS uuid), CAST(:unit AS uuid), :amount, :method, :provider, :ref, CAST(:at AS timestamptz), :note)
        RETURNING short_id""";
    static final String ALLOCATE = """
        INSERT INTO billing.payment_allocation (community_id, payment_id, target_type, target_id, due_id, amount)
        VALUES (platform.current_community(), CAST(:payment AS uuid), :type, CAST(:target AS uuid), CASE WHEN :type = 'due' THEN CAST(:target AS uuid) END, :amount)""";
    static final String CREDIT = """
        INSERT INTO billing.unit_credit (community_id, unit_id, amount, reason, source_type, source_id)
        VALUES (platform.current_community(), CAST(:unit AS uuid), :amount, :reason, :sourceType, CAST(:source AS uuid))""";
    static final String LOCK_UNIT = "SELECT u.id FROM property.unit u WHERE u.id = CAST(:unit AS uuid) FOR UPDATE";
    static final String BALANCE = "SELECT COALESCE(sum(c.amount), 0) AS balance FROM billing.unit_credit c WHERE c.unit_id = CAST(:unit AS uuid)";
    static final String CLAIM = """
        UPDATE billing.payment p SET claimed_type = :type, claimed_id = CAST(:target AS uuid), claimed_at = now()
        WHERE p.id = CAST(:payment AS uuid) AND p.unit_id = CAST(:unit AS uuid) AND p.claimed_id IS NULL
          AND EXISTS (SELECT 1 FROM billing.payment_order o WHERE o.community_id = p.community_id AND o.id = p.order_id AND o.purpose = :purpose)
        RETURNING p.amount""";
    static final String OF_ORDER = "SELECT p.id FROM billing.payment p WHERE p.order_id = CAST(:order AS uuid) ORDER BY p.received_at LIMIT 1";

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
        for (Allocation a : allocations) jdbc.update(ALLOCATE, Map.of("payment", payment.toString(), "type", a.targetType(), "target", a.targetId().toString(), "amount", a.amount().amount()));
    }
    @Override public void creditUnit(UnitId unit, Money amount, PaymentId source, String reason) {
        creditRow(unit, amount, "prepayment".equals(reason) ? "prepayment" : "overpayment", source.value(), reason);
    }
    @Override public void creditRow(UnitId unit, Money signed, String sourceType, UUID sourceId, String reason) {
        Map<String, Object> p = new HashMap<>();
        p.put("unit", unit.toString()); p.put("amount", signed.amount()); p.put("reason", reason); p.put("sourceType", sourceType); p.put("source", sourceId == null ? null : sourceId.toString());
        jdbc.update(CREDIT, p);
    }
    @Override public Money lockCreditBalance(UnitId unit) {
        jdbc.query(LOCK_UNIT, Map.of("unit", unit.toString()), (rs, i) -> null);
        return new Money(jdbc.queryForObject(BALANCE, Map.of("unit", unit.toString()), BigDecimal.class));
    }
    @Override public Optional<Money> claim(PaymentId payment, UnitId unit, String purpose, String targetType, UUID targetId) {
        return jdbc.query(CLAIM, Map.of("payment", payment.toString(), "unit", unit.toString(), "purpose", purpose, "type", targetType, "target", targetId.toString()),
            (rs, i) -> Rows.money(rs, "amount")).stream().findFirst();
    }
    @Override public Optional<PaymentId> ofOrder(OrderId order) {
        return jdbc.query(OF_ORDER, Map.of("order", order.toString()), (rs, i) -> new PaymentId(Rows.uuid(rs, "id"))).stream().findFirst();
    }

    private static Receipt map(ResultSet rs) throws SQLException {
        List<Allocation> al = new ArrayList<>();
        for (String s : Rows.list(rs, "allocations", String::valueOf)) {
            String[] kv = s.split("="); String[] tt = kv[0].split(":");
            al.add(new Allocation(tt[0], UUID.fromString(tt[1]), new Money(new BigDecimal(kv[1]))));
        }
        UUID order = Rows.uuid(rs, "order_id");
        return new Receipt(new PaymentId(Rows.uuid(rs, "id")), rs.getString("short_id"), new UnitId(Rows.uuid(rs, "unit_id")), order == null ? null : new OrderId(order),
            Rows.money(rs, "amount"), rs.getString("method"), rs.getString("provider"), Rows.instant(rs, "received_at"), al, Rows.money(rs, "credited"));
    }
}
