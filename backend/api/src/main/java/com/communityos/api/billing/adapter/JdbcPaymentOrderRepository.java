package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.PaymentOrderRepository;
import com.communityos.api.billing.domain.OrderStatus;
import com.communityos.api.billing.domain.PaymentOrder;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.OrderId;
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
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** billing.payment_order + its items, tenant connection. */
public final class JdbcPaymentOrderRepository implements PaymentOrderRepository {
    static final String COLUMNS = """
        SELECT o.id, o.community_id, o.short_id, o.purpose, o.unit_id, o.payer_membership_id, o.amount, o.currency, o.status, o.provider, o.provider_order_ref, o.idempotency_key,
               o.expires_at, o.paid_at, o.failure_reason, o.version,
               ARRAY(SELECT i.target_type || ':' || i.target_id::text || '=' || i.amount::text FROM billing.payment_order_item i
                      WHERE i.community_id = o.community_id AND i.order_id = o.id ORDER BY i.target_type, i.target_id) AS items
        FROM billing.payment_order o""";
    static final String BY_ID = COLUMNS + " WHERE o.id = CAST(:id AS uuid)";
    static final String BY_ID_LOCK = COLUMNS + " WHERE o.id = CAST(:id AS uuid) FOR UPDATE OF o";
    static final String BY_KEY = COLUMNS + " WHERE o.payer_membership_id = CAST(:payer AS uuid) AND o.idempotency_key = :key";
    static final String BY_REF_LOCK = COLUMNS + " WHERE o.provider = :provider AND o.provider_order_ref = :ref FOR UPDATE OF o";
    static final String INSERT = """
        INSERT INTO billing.payment_order (community_id, id, purpose, unit_id, payer_membership_id, amount, currency, status, provider, idempotency_key, expires_at)
        VALUES (CAST(:community AS uuid), CAST(:id AS uuid), :purpose, CAST(:unit AS uuid), CAST(:payer AS uuid), :amount, :currency, 'Created', :provider, :key, CAST(:expires AS timestamptz))
        RETURNING short_id, version""";
    static final String ITEM = """
        INSERT INTO billing.payment_order_item (community_id, order_id, target_type, target_id, amount)
        VALUES (CAST(:community AS uuid), CAST(:order AS uuid), :type, CAST(:target AS uuid), :amount)""";
    static final String CHECKED = "UPDATE billing.payment_order SET checked_at = now() WHERE id = CAST(:id AS uuid)";
    static final String UPDATE = """
        UPDATE billing.payment_order SET status = :status, provider_order_ref = :ref, paid_at = CAST(:paidAt AS timestamptz), failure_reason = :reason
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcPaymentOrderRepository(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public Optional<PaymentOrder> findById(OrderId id) { return one(BY_ID, Map.of("id", id.toString())); }
    @Override public Optional<PaymentOrder> findForUpdate(OrderId id) { return one(BY_ID_LOCK, Map.of("id", id.toString())); }
    @Override public Optional<PaymentOrder> findByIdempotencyKey(MembershipId payer, String key) { return one(BY_KEY, Map.of("payer", payer.toString(), "key", key)); }
    @Override public Optional<PaymentOrder> findByProviderRefForUpdate(String provider, String ref) { return one(BY_REF_LOCK, Map.of("provider", provider, "ref", ref)); }

    @Override public void insert(PaymentOrder o) {
        Map<String, Object> p = new HashMap<>();
        p.put("community", o.community().toString()); p.put("id", o.id().toString()); p.put("purpose", o.purpose()); p.put("unit", o.unit().toString()); p.put("payer", o.payer().toString());
        p.put("amount", o.amount().amount()); p.put("currency", o.currency()); p.put("provider", o.provider()); p.put("key", o.idempotencyKey()); p.put("expires", Rows.ts(o.expiresAt()));
        jdbc.query(INSERT, p, (rs, i) -> { o.numbered(rs.getString("short_id")); o.stored(rs.getLong("version")); return null; });
        for (PaymentOrder.Item it : o.items())
            jdbc.update(ITEM, Map.of("community", o.community().toString(), "order", o.id().toString(), "type", it.targetType(), "target", it.target().toString(), "amount", it.amount().amount()));
    }
    @Override public void checked(OrderId id) { jdbc.update(CHECKED, Map.of("id", id.toString())); }
    @Override public boolean save(PaymentOrder o) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", o.id().toString()); p.put("version", o.version()); p.put("status", o.status().label()); p.put("ref", o.providerOrderRef());
        p.put("paidAt", Rows.ts(o.paidAt())); p.put("reason", o.failureReason());
        List<Long> v = jdbc.query(UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        o.stored(v.get(0));
        return true;
    }

    private Optional<PaymentOrder> one(String sql, Map<String, Object> p) { return jdbc.query(sql, p, (rs, i) -> map(rs)).stream().findFirst(); }
    private static PaymentOrder map(ResultSet rs) throws SQLException {
        List<PaymentOrder.Item> items = new ArrayList<>();
        for (String s : Rows.list(rs, "items", String::valueOf)) {
            String[] kv = s.split("="); String[] tt = kv[0].split(":");
            items.add(new PaymentOrder.Item(tt[0], UUID.fromString(tt[1]), new Money(new BigDecimal(kv[1]))));
        }
        return new PaymentOrder(rs.getString("purpose"), new OrderId(Rows.uuid(rs, "id")), new CommunityId(Rows.uuid(rs, "community_id")), rs.getString("short_id"), new UnitId(Rows.uuid(rs, "unit_id")),
            new MembershipId(Rows.uuid(rs, "payer_membership_id")), Rows.money(rs, "amount"), rs.getString("currency"), OrderStatus.of(rs.getString("status")), rs.getString("provider"),
            rs.getString("provider_order_ref"), rs.getString("idempotency_key"), Rows.instant(rs, "expires_at"), Rows.instant(rs, "paid_at"), rs.getString("failure_reason"), items,
            rs.getLong("version"));
    }
}
