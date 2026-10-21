package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.RefundService;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.jdbc.Rows;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Refunds on the tenant connection (Store), and found by the provider's reference across communities on the platform one (Locator). */
public final class JdbcRefunds implements RefundService.Store, RefundService.Locator {
    static final String PAYMENT = "SELECT id, provider, provider_payment_ref, amount FROM billing.payment WHERE id = CAST(:id AS uuid) AND provider IS NOT NULL AND provider_payment_ref IS NOT NULL";
    static final String COLS = "r.id, r.short_id, r.community_id, r.owner_type, r.owner_id, r.part, r.payment_id, r.provider, r.provider_payment_ref, r.provider_refund_ref, r.amount, r.status, r.failure_reason, r.processed_at";
    static final String INSERT = """
        INSERT INTO billing.gateway_refund (community_id, owner_type, owner_id, part, payment_id, provider, provider_payment_ref, amount)
        VALUES (platform.current_community(), :ownerType, CAST(:owner AS uuid), :part, CAST(:payment AS uuid), :provider, :ref, :amount) RETURNING id""";
    static final String GET = "SELECT " + COLS + " FROM billing.gateway_refund r WHERE r.id = CAST(:id AS uuid)";
    static final String OWNER = "SELECT " + COLS + " FROM billing.gateway_refund r WHERE r.owner_type = :ownerType AND r.owner_id = CAST(:owner AS uuid) ORDER BY r.created_at";
    static final String ASKED = "UPDATE billing.gateway_refund SET provider_refund_ref = :ref WHERE id = CAST(:id AS uuid) AND provider_refund_ref IS NULL";
    static final String FINISH = """
        UPDATE billing.gateway_refund SET status = :status, failure_reason = :reason, processed_at = CASE WHEN :status = 'Processed' THEN CAST(:at AS timestamptz) END
        WHERE id = CAST(:id AS uuid) AND status = 'Pending'""";
    static final String BY_REF = "SELECT community_id, id FROM billing.gateway_refund WHERE provider = :provider AND provider_refund_ref = :ref";
    static final String PENDING = "SELECT community_id, id FROM billing.gateway_refund WHERE status = 'Pending' AND provider_refund_ref IS NOT NULL AND created_at < CAST(:before AS timestamptz) ORDER BY created_at LIMIT :limit";

    private final NamedParameterJdbcTemplate app; private final NamedParameterJdbcTemplate platform;
    public JdbcRefunds(NamedParameterJdbcTemplate app, NamedParameterJdbcTemplate platform) { this.app = app; this.platform = platform; }

    @Override public Optional<OnlinePayment> onlinePayment(UUID paymentId) {
        return app.query(PAYMENT, Map.of("id", paymentId.toString()), (rs, i) -> new OnlinePayment(Rows.uuid(rs, "id"), rs.getString("provider"), rs.getString("provider_payment_ref"),
            Rows.money(rs, "amount"))).stream().findFirst();
    }
    @Override public RefundService.Refund insert(String ownerType, UUID ownerId, String part, OnlinePayment p, Money amount) {
        UUID id = app.query(INSERT, Map.of("ownerType", ownerType, "owner", ownerId.toString(), "part", part, "payment", p.id().toString(), "provider", p.provider(),
            "ref", p.providerPaymentRef(), "amount", amount.amount()), (rs, i) -> Rows.uuid(rs, "id")).get(0);
        return get(id).orElseThrow();
    }
    @Override public Optional<RefundService.Refund> get(UUID id) { return app.query(GET, Map.of("id", id.toString()), (rs, i) -> map(rs)).stream().findFirst(); }
    @Override public void asked(UUID id, String ref) { app.update(ASKED, Map.of("id", id.toString(), "ref", ref)); }
    @Override public boolean finish(UUID id, String status, String reason, Instant at) {
        Map<String, Object> p = new HashMap<>(); p.put("id", id.toString()); p.put("status", status); p.put("reason", reason); p.put("at", Rows.ts(at));
        return app.update(FINISH, p) == 1;
    }
    @Override public List<RefundService.Refund> ofOwner(String ownerType, UUID ownerId) { return app.query(OWNER, Map.of("ownerType", ownerType, "owner", ownerId.toString()), (rs, i) -> map(rs)); }

    @Override public Optional<Located> byProviderRef(String provider, String ref) {
        return platform.query(BY_REF, Map.of("provider", provider, "ref", ref), (rs, i) -> new Located(new CommunityId(Rows.uuid(rs, "community_id")), Rows.uuid(rs, "id"))).stream().findFirst();
    }
    @Override public List<Located> pendingOlderThan(Instant before, int limit) {
        return platform.query(PENDING, Map.of("before", Rows.ts(before), "limit", limit), (rs, i) -> new Located(new CommunityId(Rows.uuid(rs, "community_id")), Rows.uuid(rs, "id")));
    }

    private static RefundService.Refund map(ResultSet rs) throws SQLException {
        return new RefundService.Refund(Rows.uuid(rs, "id"), rs.getString("short_id"), new CommunityId(Rows.uuid(rs, "community_id")), rs.getString("owner_type"), Rows.uuid(rs, "owner_id"),
            rs.getString("part"), Rows.uuid(rs, "payment_id"), rs.getString("provider"), rs.getString("provider_payment_ref"), rs.getString("provider_refund_ref"), Rows.money(rs, "amount"),
            rs.getString("status"), rs.getString("failure_reason"), Rows.instant(rs, "processed_at"));
    }
}
