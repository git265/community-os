package com.communityos.api.amenity.adapter;

import com.communityos.api.amenity.application.port.BookingRepository;
import com.communityos.api.amenity.domain.AmenityType;
import com.communityos.api.amenity.domain.Booking;
import com.communityos.api.amenity.domain.Pricing;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** amenity.booking on the tenant connection, with its amenity, unit and the people involved joined in. */
public final class JdbcBookingRepository implements BookingRepository {
    static final String COLUMNS = """
        SELECT b.id, b.short_id, b.amenity_type_id, t.name AS amenity_name, b.unit_id, u.unit_no, b.date, b.slot, b.start_at, b.status, b.payment_mode, b.payment_status,
               b.booked_for, b.association, b.rate, b.rate_unit, b.base_amount, b.gst_rate, b.gst_amount, b.gst_mode, b.fee_total, b.deposit_amount, b.total_payable,
               b.extras::text AS extras, b.extras_total, b.policy_snapshot::text AS policy, b.charge_waived, b.waived_amount, b.waive_reason, b.credit_applied, b.paid_amount,
               b.paid_at, b.payment_ref, b.payment_id, b.deposit_status, b.refund_status, b.refund_amount, b.cancel_reason, b.cancelled_at, b.cancelled_by_id,
               cb.display_name AS cancelled_by_name, b.completed_at, b.refund_pct, b.refund_fee_amount, b.deposit_returned, b.retained_amount, b.refund_to, b.refund_paid_at,
               b.refund_paid_by_id, b.refund_payout_mode, b.refund_ref, b.deposit_deduction, b.deposit_deduction_reason, b.deposit_settled_at, b.deposit_refund_mode,
               b.deposit_refund_status, b.deposit_refund_paid_at, b.deposit_refund_ref, b.fee_corrected_from, b.fee_correction_reason, b.booked_by_id,
               bb.display_name AS booked_by_name, b.created_at, b.updated_at, b.version""";
    static final String FROM = """
        FROM amenity.booking b
        JOIN amenity.amenity_type t ON t.community_id = b.community_id AND t.id = b.amenity_type_id
        LEFT JOIN property.unit u ON u.community_id = b.community_id AND u.id = b.unit_id
        LEFT JOIN identity.membership cb ON cb.community_id = b.community_id AND cb.id = b.cancelled_by_id
        LEFT JOIN identity.membership bb ON bb.community_id = b.community_id AND bb.id = b.booked_by_id""";
    static final String FILTER = """
        WHERE (CAST(:amenity AS uuid) IS NULL OR b.amenity_type_id = CAST(:amenity AS uuid))
          AND (CAST(:from AS date) IS NULL OR b.date >= CAST(:from AS date))
          AND (CAST(:to AS date) IS NULL OR b.date <= CAST(:to AS date))
          AND (CAST(:status AS text) IS NULL OR b.status = :status)
          AND (CAST(:unit AS uuid) IS NULL OR b.unit_id = CAST(:unit AS uuid))
          AND (CAST(:open AS boolean) IS FALSE OR b.refund_status = 'Refund due' OR b.deposit_refund_status = 'Due' OR b.payment_status = 'Pending' OR b.deposit_status = 'Held')""";
    static final String INSERT = """
        INSERT INTO amenity.booking (community_id, id, amenity_type_id, unit_id, date, slot, start_at, status, payment_mode, payment_status, booked_for, association, rate, rate_unit,
                                     base_amount, gst_rate, gst_amount, gst_mode, fee_total, deposit_amount, total_payable, extras, extras_total, policy_snapshot, charge_waived,
                                     waived_amount, waive_reason, credit_applied, deposit_status, refund_status, booked_by_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:amenity AS uuid), CAST(:unit AS uuid), CAST(:date AS date), :slot, CAST(:startAt AS timestamptz), :status,
                :paymentMode, :paymentStatus, :bookedFor, :association, :rate, :rateUnit, :base, :gstRate, :gst, :gstMode, :fee, :deposit, :total, CAST(:extras AS jsonb), :extrasTotal,
                CAST(:policy AS jsonb), :waived, :waivedAmount, :waiveReason, :credit, :depositStatus, :refundStatus, CAST(:bookedBy AS uuid))
        RETURNING short_id, version, created_at""";
    static final String UPDATE = """
        UPDATE amenity.booking SET status = :status, payment_mode = :paymentMode, payment_status = :paymentStatus, base_amount = :base, gst_amount = :gst, fee_total = :fee,
               total_payable = :total, credit_applied = :credit, paid_amount = :paid, paid_at = CAST(:paidAt AS timestamptz), payment_ref = :paymentRef,
               payment_id = CAST(:paymentId AS uuid), deposit_status = :depositStatus, refund_status = :refundStatus, refund_amount = :refundAmount, cancel_reason = :cancelReason,
               cancelled_at = CAST(:cancelledAt AS timestamptz), cancelled_by_id = CAST(:cancelledBy AS uuid), completed_at = CAST(:completedAt AS timestamptz),
               refund_pct = :refundPct, refund_fee_amount = :refundFee, deposit_returned = :depositReturned, retained_amount = :retained, refund_to = :refundTo,
               refund_paid_at = CAST(:refundPaidAt AS timestamptz), refund_paid_by_id = CAST(:refundPaidBy AS uuid), refund_payout_mode = :refundPayoutMode, refund_ref = :refundRef,
               deposit_deduction = :deduction, deposit_deduction_reason = :deductionReason, deposit_settled_at = CAST(:depositSettledAt AS timestamptz),
               deposit_refund_mode = :depositRefundMode, deposit_refund_status = :depositRefundStatus, deposit_refund_paid_at = CAST(:depositRefundPaidAt AS timestamptz),
               deposit_refund_ref = :depositRefundRef, fee_corrected_from = :feeFrom, fee_correction_reason = :feeReason
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version, updated_at""";
    /** A day's live bookings of one amenity, or (amenity null) of every amenity - the add-on items are one stock for the whole community. */
    static final String LIVE_ON = COLUMNS + "\n" + FROM + "\nWHERE (CAST(:amenity AS uuid) IS NULL OR b.amenity_type_id = CAST(:amenity AS uuid)) AND b.date = CAST(:date AS date) AND b.status <> 'Cancelled'";
    static final String HELD = "SELECT b.date, b.status FROM amenity.booking b WHERE b.amenity_type_id = CAST(:amenity AS uuid) AND b.unit_id = CAST(:unit AS uuid) AND b.status <> 'Cancelled'";
    static final String TAKEN = """
        SELECT b.amenity_type_id, b.date, b.slot, count(*) AS n,
               ARRAY(SELECT (x ->> 'itemId') || '=' || sum((x ->> 'qty')::int)::text
                     FROM amenity.booking b2, jsonb_array_elements(b2.extras) x
                     WHERE b2.community_id = b.community_id AND b2.amenity_type_id = b.amenity_type_id AND b2.date = b.date AND b2.slot = b.slot AND b2.status <> 'Cancelled'
                     GROUP BY x ->> 'itemId') AS items
        FROM amenity.booking b
        WHERE (CAST(:amenity AS uuid) IS NULL OR b.amenity_type_id = CAST(:amenity AS uuid)) AND b.date BETWEEN CAST(:from AS date) AND CAST(:to AS date) AND b.status <> 'Cancelled'
        GROUP BY b.community_id, b.amenity_type_id, b.date, b.slot ORDER BY b.date, b.slot""";

    public static String listSql(String scope) { return COLUMNS + "\n" + FROM + "\n" + FILTER + "\n  AND " + scope + "\nORDER BY b.date DESC, b.start_at DESC, b.id LIMIT 2000"; }
    public static String getSql(String scope) { return COLUMNS + "\n" + FROM + "\nWHERE b.id = CAST(:id AS uuid) AND " + scope; }

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcBookingRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public List<Booking> find(Spec<Booking> scope, Filter f) {
        Map<String, Object> p = new HashMap<>(scope.params());
        p.put("amenity", f.amenityTypeId() == null ? null : f.amenityTypeId().toString()); p.put("from", Rows.sqlDate(f.from())); p.put("to", Rows.sqlDate(f.to()));
        p.put("status", f.status()); p.put("unit", f.unit() == null ? null : f.unit().toString()); p.put("open", f.openMoney());
        return jdbc.query(listSql(scope.sql()), p, (rs, i) -> map(rs));
    }
    @Override public Optional<Booking> get(UUID id, Spec<Booking> scope) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString());
        return jdbc.query(getSql(scope.sql()), p, (rs, i) -> map(rs)).stream().findFirst();
    }
    @Override public void insert(Booking b) {
        Booking.State s = b.state();
        Map<String, Object> p = new HashMap<>();
        p.put("id", s.id.toString()); p.put("amenity", s.amenityTypeId.toString()); p.put("unit", s.unit == null ? null : s.unit.toString()); p.put("date", Rows.sqlDate(s.date));
        p.put("slot", s.slot); p.put("startAt", Rows.ts(s.startAt)); p.put("status", s.status); p.put("paymentMode", s.paymentMode); p.put("paymentStatus", s.paymentStatus);
        p.put("bookedFor", s.bookedFor); p.put("association", s.association); p.put("rate", s.rate); p.put("rateUnit", s.rateUnit); p.put("base", s.baseAmount); p.put("gstRate", s.gstRate);
        p.put("gst", s.gstAmount); p.put("gstMode", s.gstMode); p.put("fee", s.feeTotal); p.put("deposit", s.depositAmount); p.put("total", s.totalPayable); p.put("extras", write(s.extras));
        p.put("extrasTotal", s.extrasTotal); p.put("policy", write(s.policy)); p.put("waived", s.chargeWaived); p.put("waivedAmount", s.waivedAmount); p.put("waiveReason", s.waiveReason);
        p.put("credit", s.creditApplied); p.put("depositStatus", s.depositStatus); p.put("refundStatus", s.refundStatus); p.put("bookedBy", s.bookedBy == null ? null : s.bookedBy.toString());
        jdbc.query(INSERT, p, (rs, i) -> { s.shortId = rs.getString("short_id"); s.version = rs.getLong("version"); s.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean save(Booking b) {
        Booking.State s = b.state();
        Map<String, Object> p = new HashMap<>();
        p.put("id", s.id.toString()); p.put("version", s.version); p.put("status", s.status); p.put("paymentMode", s.paymentMode); p.put("paymentStatus", s.paymentStatus);
        p.put("base", s.baseAmount); p.put("gst", s.gstAmount); p.put("fee", s.feeTotal); p.put("total", s.totalPayable); p.put("credit", s.creditApplied); p.put("paid", s.paidAmount);
        p.put("paidAt", Rows.ts(s.paidAt)); p.put("paymentRef", s.paymentRef); p.put("paymentId", s.paymentId == null ? null : s.paymentId.toString()); p.put("depositStatus", s.depositStatus);
        p.put("refundStatus", s.refundStatus); p.put("refundAmount", s.refundAmount); p.put("cancelReason", s.cancelReason); p.put("cancelledAt", Rows.ts(s.cancelledAt));
        p.put("cancelledBy", s.cancelledBy == null ? null : s.cancelledBy.toString()); p.put("completedAt", Rows.ts(s.completedAt)); p.put("refundPct", s.refundPct);
        p.put("refundFee", s.refundFeeAmount); p.put("depositReturned", s.depositReturned); p.put("retained", s.retainedAmount); p.put("refundTo", s.refundTo);
        p.put("refundPaidAt", Rows.ts(s.refundPaidAt)); p.put("refundPaidBy", s.refundPaidBy == null ? null : s.refundPaidBy.toString()); p.put("refundPayoutMode", s.refundPayoutMode);
        p.put("refundRef", s.refundRef); p.put("deduction", s.depositDeduction); p.put("deductionReason", s.depositDeductionReason); p.put("depositSettledAt", Rows.ts(s.depositSettledAt));
        p.put("depositRefundMode", s.depositRefundMode); p.put("depositRefundStatus", s.depositRefundStatus); p.put("depositRefundPaidAt", Rows.ts(s.depositRefundPaidAt));
        p.put("depositRefundRef", s.depositRefundRef); p.put("feeFrom", s.feeCorrectedFrom); p.put("feeReason", s.feeCorrectionReason);
        List<Long> v = jdbc.query(UPDATE, p, (rs, i) -> { s.updatedAt = Rows.instant(rs, "updated_at"); return rs.getLong("version"); });
        if (v.isEmpty()) return false;
        s.version = v.get(0);
        return true;
    }
    @Override public List<Booking> liveOn(UUID amenityTypeId, LocalDate date) {
        Map<String, Object> p = new HashMap<>(); p.put("amenity", amenityTypeId == null ? null : amenityTypeId.toString()); p.put("date", Rows.sqlDate(date));
        return jdbc.query(LIVE_ON, p, (rs, i) -> map(rs));
    }
    @Override public List<Pricing.Held> heldBy(UUID amenityTypeId, UnitId unit) {
        return jdbc.query(HELD, Map.of("amenity", amenityTypeId.toString(), "unit", unit.toString()), (rs, i) -> new Pricing.Held(Rows.date(rs, "date"), "Completed".equals(rs.getString("status"))));
    }
    @Override public List<Taken> taken(UUID amenityTypeId, LocalDate from, LocalDate to) {
        Map<String, Object> p = new HashMap<>(); p.put("amenity", amenityTypeId == null ? null : amenityTypeId.toString()); p.put("from", Rows.sqlDate(from)); p.put("to", Rows.sqlDate(to));
        return jdbc.query(TAKEN, p, (rs, i) -> {
            Map<UUID, Integer> items = new LinkedHashMap<>();
            for (String s : Rows.list(rs, "items", String::valueOf)) { String[] kv = s.split("="); try { items.put(UUID.fromString(kv[0]), Integer.parseInt(kv[1])); } catch (RuntimeException ignored) { } }
            return new Taken(Rows.uuid(rs, "amenity_type_id"), Rows.date(rs, "date"), rs.getString("slot"), rs.getInt("n"), items);
        });
    }

    private Booking map(ResultSet rs) throws SQLException {
        Booking.State s = new Booking.State();
        s.id = Rows.uuid(rs, "id"); s.shortId = rs.getString("short_id"); s.amenityTypeId = Rows.uuid(rs, "amenity_type_id"); s.amenityName = rs.getString("amenity_name");
        UUID unit = Rows.uuid(rs, "unit_id"); s.unit = unit == null ? null : new UnitId(unit); s.unitNo = rs.getString("unit_no"); s.date = Rows.date(rs, "date"); s.slot = rs.getString("slot");
        s.startAt = Rows.instant(rs, "start_at"); s.status = rs.getString("status"); s.paymentMode = rs.getString("payment_mode"); s.paymentStatus = rs.getString("payment_status");
        s.bookedFor = rs.getString("booked_for"); s.association = rs.getString("association"); s.rate = rs.getBigDecimal("rate"); s.rateUnit = rs.getString("rate_unit");
        s.baseAmount = rs.getBigDecimal("base_amount"); s.gstRate = rs.getBigDecimal("gst_rate"); s.gstAmount = rs.getBigDecimal("gst_amount"); s.gstMode = rs.getString("gst_mode");
        s.feeTotal = rs.getBigDecimal("fee_total"); s.depositAmount = rs.getBigDecimal("deposit_amount"); s.totalPayable = rs.getBigDecimal("total_payable");
        try {
            s.extras = json.readValue(rs.getString("extras"), new TypeReference<List<Pricing.Line>>() {});
            s.policy = json.readValue(rs.getString("policy"), new TypeReference<List<AmenityType.Tier>>() {});
        } catch (java.io.IOException e) { throw new SQLException(e); }
        s.extrasTotal = rs.getBigDecimal("extras_total"); s.chargeWaived = rs.getBoolean("charge_waived"); s.waivedAmount = rs.getBigDecimal("waived_amount"); s.waiveReason = rs.getString("waive_reason");
        s.creditApplied = nz(rs.getBigDecimal("credit_applied")); s.paidAmount = nz(rs.getBigDecimal("paid_amount")); s.paidAt = Rows.instant(rs, "paid_at"); s.paymentRef = rs.getString("payment_ref");
        s.paymentId = Rows.uuid(rs, "payment_id"); s.depositStatus = rs.getString("deposit_status"); s.refundStatus = rs.getString("refund_status"); s.refundAmount = nz(rs.getBigDecimal("refund_amount"));
        s.cancelReason = rs.getString("cancel_reason"); s.cancelledAt = Rows.instant(rs, "cancelled_at"); s.cancelledBy = Rows.uuid(rs, "cancelled_by_id"); s.cancelledByName = rs.getString("cancelled_by_name");
        s.completedAt = Rows.instant(rs, "completed_at"); s.refundPct = rs.getBigDecimal("refund_pct"); s.refundFeeAmount = rs.getBigDecimal("refund_fee_amount");
        s.depositReturned = rs.getBigDecimal("deposit_returned"); s.retainedAmount = rs.getBigDecimal("retained_amount"); s.refundTo = rs.getString("refund_to");
        s.refundPaidAt = Rows.instant(rs, "refund_paid_at"); s.refundPaidBy = Rows.uuid(rs, "refund_paid_by_id"); s.refundPayoutMode = rs.getString("refund_payout_mode"); s.refundRef = rs.getString("refund_ref");
        s.depositDeduction = rs.getBigDecimal("deposit_deduction"); s.depositDeductionReason = rs.getString("deposit_deduction_reason"); s.depositSettledAt = Rows.instant(rs, "deposit_settled_at");
        s.depositRefundMode = rs.getString("deposit_refund_mode"); s.depositRefundStatus = rs.getString("deposit_refund_status"); s.depositRefundPaidAt = Rows.instant(rs, "deposit_refund_paid_at");
        s.depositRefundRef = rs.getString("deposit_refund_ref"); s.feeCorrectedFrom = rs.getBigDecimal("fee_corrected_from"); s.feeCorrectionReason = rs.getString("fee_correction_reason");
        s.bookedBy = Rows.uuid(rs, "booked_by_id"); s.bookedByName = rs.getString("booked_by_name"); s.createdAt = Rows.instant(rs, "created_at"); s.updatedAt = Rows.instant(rs, "updated_at");
        s.version = rs.getLong("version");
        return new Booking(s);
    }
    private static BigDecimal nz(BigDecimal b) { return b == null ? BigDecimal.ZERO : b; }
    private String write(Object o) { try { return json.writeValueAsString(o); } catch (Exception e) { throw new IllegalStateException(e); } }
}
