package com.communityos.payments;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

/** payment_orders / payment_events (db/V3). Joins the caller's transaction when there is one, so `lock` really holds the row. */
public class JdbcPaymentStore implements PaymentStore {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    private final RowMapper<PaymentOrder> map = this::row;

    public JdbcPaymentStore(JdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    private JsonNode parse(String s) {
        if (s == null) return null;
        try { return json.readTree(s); } catch (Exception e) { throw new IllegalStateException("Unreadable JSON in payment_orders", e); }
    }

    private PaymentOrder row(ResultSet rs, int i) throws SQLException {
        List<String> refs = new ArrayList<>();
        JsonNode r = parse(rs.getString("refs"));
        if (r != null) r.forEach(x -> refs.add(x.asText()));
        JsonNode meta = parse(rs.getString("meta"));
        return new PaymentOrder(rs.getString("order_id"), rs.getString("tenant"), rs.getString("purpose"), refs, rs.getString("unit"), rs.getString("payer"),
                rs.getString("payer_id"), rs.getBigDecimal("amount"), rs.getString("currency"), rs.getString("status"), rs.getString("idempotency_key"),
                meta == null ? json.createObjectNode() : meta, rs.getString("provider"), rs.getString("provider_ref"), rs.getString("payment_id"), rs.getString("method"),
                parse(rs.getString("bank")), rs.getString("consumed_by"), rs.getString("note"), rs.getInt("attempts"), ts(rs, "created_at"), ts(rs, "updated_at"), ts(rs, "paid_at"));
    }

    private static java.time.Instant ts(ResultSet rs, String col) throws SQLException { Timestamp t = rs.getTimestamp(col); return t == null ? null : t.toInstant(); }

    private Optional<PaymentOrder> one(String sql, Object... args) { return jdbc.query(sql, map, args).stream().findFirst(); }

    @Override public void insert(PaymentOrder o) {
        jdbc.update("INSERT INTO payment_orders (order_id, tenant, purpose, refs, unit, payer, payer_id, amount, currency, idempotency_key, meta, provider, provider_ref) "
                        + "VALUES (?,?,?,?::jsonb,?,?,?,?,?,?,?::jsonb,?,?)",
                o.orderId(), o.tenant(), o.purpose(), json.valueToTree(o.refs()).toString(), o.unit(), o.payer(), o.payerId(), o.amount(), o.currency(),
                o.idempotencyKey(), o.meta().toString(), o.provider(), o.providerRef());
    }
    @Override public Optional<PaymentOrder> get(String tenant, String id) { return one("SELECT * FROM payment_orders WHERE order_id=? AND tenant=?", id, tenant); }
    @Override public Optional<PaymentOrder> find(String id) { return one("SELECT * FROM payment_orders WHERE order_id=?", id); }
    @Override public Optional<PaymentOrder> findByProviderRef(String ref) { return one("SELECT * FROM payment_orders WHERE provider_ref=? LIMIT 1", ref); }
    @Override public Optional<PaymentOrder> lock(String tenant, String id) { return one("SELECT * FROM payment_orders WHERE order_id=? AND tenant=? FOR UPDATE", id, tenant); }
    @Override public Optional<PaymentOrder> lockOpenByKey(String tenant, String key) {
        return one("SELECT * FROM payment_orders WHERE tenant=? AND idempotency_key=? AND status IN ('Created','Pending') FOR UPDATE", tenant, key);
    }
    @Override public boolean paidWithKey(String tenant, String key) {
        return !jdbc.queryForList("SELECT 1 FROM payment_orders WHERE tenant=? AND idempotency_key=? AND status='Paid'", tenant, key).isEmpty();
    }
    @Override public Optional<PaymentOrder> unusedPaidBooking(String tenant, String unit, BigDecimal amount, String payerId) {
        return one("SELECT * FROM payment_orders WHERE tenant=? AND purpose='booking' AND status='Paid' AND consumed_by IS NULL AND unit=? AND amount=? AND payer_id=? ORDER BY paid_at DESC LIMIT 1",
                tenant, unit, amount, payerId);
    }
    @Override public boolean recordEvent(String eventId, String orderId, String type) {
        return jdbc.update("INSERT INTO payment_events (event_id, order_id, type) VALUES (?,?,?) ON CONFLICT DO NOTHING", eventId, orderId, type) > 0;
    }
    @Override public void markPaid(String id, String paymentId, String method) {
        jdbc.update("UPDATE payment_orders SET status='Paid', payment_id=?, method=?, paid_at=now(), updated_at=now() WHERE order_id=?", paymentId, method, id);
    }
    @Override public void markFailed(String id, String note) { jdbc.update("UPDATE payment_orders SET status='Failed', note=?, updated_at=now() WHERE order_id=?", note, id); }
    @Override public int moveOpen(String id, String status, String method, String note) {
        return jdbc.update("UPDATE payment_orders SET status=?, method=COALESCE(?, method), note=COALESCE(?, note), updated_at=now() WHERE order_id=? AND status IN ('Created','Pending')",
                status, method, note, id);
    }
    @Override public void touch(String id) { jdbc.update("UPDATE payment_orders SET updated_at=now() WHERE order_id=?", id); }
    @Override public void recordBank(String id, JsonNode bank) { jdbc.update("UPDATE payment_orders SET bank=?::jsonb, attempts=attempts+1, updated_at=now() WHERE order_id=?", bank.toString(), id); }
    @Override public List<PaymentOrder> openNotTouchedFor(long seconds, int limit) {
        return jdbc.query("SELECT * FROM payment_orders WHERE status IN ('Created','Pending') AND updated_at < now() - make_interval(secs => ?) ORDER BY created_at LIMIT ?", map, (double) seconds, limit);
    }
    @Override public Optional<PaymentOrder> paidBookingByPaymentId(String tenant, String paymentId) {
        return one("SELECT * FROM payment_orders WHERE tenant=? AND payment_id=? AND purpose='booking' AND status='Paid'", tenant, paymentId);
    }
    @Override public boolean claim(String id, String bookingId) {
        return jdbc.update("UPDATE payment_orders SET consumed_by=? WHERE order_id=? AND (consumed_by IS NULL OR consumed_by=?)", bookingId, id, bookingId) > 0;
    }
}
