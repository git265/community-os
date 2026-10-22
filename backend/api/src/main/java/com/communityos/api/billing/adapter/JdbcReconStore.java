package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.ReconStore;
import com.communityos.api.billing.domain.Recon;
import com.communityos.api.shared.jdbc.Rows;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The record checks as SQL over the billing and finance tables (tenant connection: the caller's community only), and the issues. */
public final class JdbcReconStore implements ReconStore {
    /** A payment split over bills: what it was split into plus what it left as credit is what it brought in. */
    static final String ALLOCATIONS = """
        SELECT p.id, p.short_id, p.provider_payment_ref, p.amount AS expected, x.split AS actual FROM billing.payment p
        CROSS JOIN LATERAL (SELECT coalesce((SELECT sum(a.amount) FROM billing.payment_allocation a WHERE a.community_id = p.community_id AND a.payment_id = p.id), 0)
                                 + coalesce((SELECT sum(c.amount) FROM billing.unit_credit c WHERE c.community_id = p.community_id AND c.source_type = 'overpayment' AND c.source_id = p.id), 0) AS split) x
        WHERE p.status <> 'Reversed' AND EXISTS (SELECT 1 FROM billing.payment_allocation a WHERE a.community_id = p.community_id AND a.payment_id = p.id)
          AND x.split <> p.amount
        LIMIT 500""";
    /** A bill's paid amount is what was allocated to it. */
    static final String BILLS = """
        SELECT d.id, d.short_id, x.allocated AS expected, d.paid_amount AS actual FROM billing.due d
        CROSS JOIN LATERAL (SELECT coalesce(sum(a.amount), 0) AS allocated FROM billing.payment_allocation a WHERE a.community_id = d.community_id AND a.due_id = d.id) x
        WHERE d.paid_amount <> x.allocated
        LIMIT 500""";
    /** A paid order: the provider captured what the server priced; and once. */
    static final String ORDERS = """
        SELECT o.id, o.short_id, o.provider_order_ref, o.amount AS expected, coalesce(sum(p.amount), 0) AS actual, count(p.id) AS payments FROM billing.payment_order o
        JOIN billing.payment p ON p.community_id = o.community_id AND p.order_id = o.id
        WHERE o.status = 'Paid' GROUP BY o.id, o.short_id, o.provider_order_ref, o.amount
        HAVING count(p.id) > 1 OR coalesce(sum(p.amount), 0) <> o.amount
        LIMIT 500""";
    /** A refund asked from the provider an hour ago or more that it has not answered. */
    static final String REFUNDS = """
        SELECT r.id, r.short_id, r.provider_refund_ref, r.amount FROM billing.gateway_refund r
        WHERE r.status = 'Pending' AND r.created_at < now() - interval '1 hour' LIMIT 500""";
    /** The books: debits equal credits; the unit-credit account holds what the units' credit rows add up to. */
    static final String LEDGER = """
        WITH posted AS (SELECT l.account_id, l.debit, l.credit FROM finance.journal_line l
                        JOIN finance.journal_entry e ON e.community_id = l.community_id AND e.id = l.entry_id AND e.status = 'Posted')
        SELECT platform.current_community() AS id, coalesce((SELECT sum(debit) FROM posted), 0) AS debit, coalesce((SELECT sum(credit) FROM posted), 0) AS credit,
               coalesce((SELECT sum(p.credit) - sum(p.debit) FROM posted p JOIN finance.account a ON a.id = p.account_id WHERE a.code = '2000'), 0) AS credit_held,
               coalesce((SELECT sum(c.amount) FROM billing.unit_credit c), 0) AS credit_rows""";
    /** Online money a week old that no payout has brought to the bank yet (only where statements are imported: without them nothing is matched). */
    static final String PAYOUTS = """
        SELECT platform.current_community() AS id, count(*) AS n, coalesce(sum(p.amount - p.refunded_amount), 0) AS amount FROM billing.payment p
        WHERE p.provider IS NOT NULL AND p.payout_entry_id IS NULL AND p.status IN ('Captured', 'Partly refunded') AND p.received_at < now() - interval '7 days'
          AND EXISTS (SELECT 1 FROM finance.bank_txn t WHERE t.date > current_date - 60)
        HAVING count(*) > 0""";
    static final String KEEP = """
        INSERT INTO billing.recon_issue (community_id, kind, ref_type, ref_id, ref_short_id, provider_ref, expected, actual, detail)
        VALUES (platform.current_community(), :kind, :refType, CAST(:refId AS uuid), :refShort, :providerRef, :expected, :actual, :detail)
        ON CONFLICT (community_id, kind, ref_id) DO UPDATE SET last_seen_at = now(), expected = excluded.expected, actual = excluded.actual, detail = excluded.detail
          WHERE (billing.recon_issue.expected, billing.recon_issue.actual, billing.recon_issue.detail) IS DISTINCT FROM (excluded.expected, excluded.actual, excluded.detail)
        RETURNING (xmax = 0) AS inserted""";   // the same finding again changes nothing (and so does not disturb the treasurer's open copy)
    static final String CLEAR = """
        UPDATE billing.recon_issue SET status = 'Resolved', note = 'Cleared: no longer found', resolved_at = now()
        WHERE status = 'Open' AND kind IN (:kinds) AND NOT (kind || ':' || ref_id::text = ANY (CAST(:found AS text[])))""";
    static final String COLS = """
        SELECT i.id, i.short_id, i.kind, i.ref_type, i.ref_id, i.ref_short_id, i.provider_ref, i.expected, i.actual, i.detail, i.status, i.note, m.display_name AS resolved_by_name,
               i.resolved_at, i.found_at, i.last_seen_at, i.version
        FROM billing.recon_issue i LEFT JOIN identity.membership m ON m.community_id = i.community_id AND m.id = i.resolved_by""";
    static final String LIST = COLS + "\nWHERE (CAST(:status AS text) IS NULL OR i.status = :status) ORDER BY i.status = 'Open' DESC, i.found_at DESC LIMIT 1000";
    static final String ONE = COLS + "\nWHERE i.id = CAST(:id AS uuid)";
    static final String RESOLVE = """
        UPDATE billing.recon_issue SET status = :status, note = :note, resolved_by = CAST(:by AS uuid), resolved_at = CAST(:at AS timestamptz)
        WHERE id = CAST(:id AS uuid) AND version = :version""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcReconStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public List<Recon.Finding> recordChecks() {
        List<Recon.Finding> out = new ArrayList<>();
        out.addAll(jdbc.query(ALLOCATIONS, Map.of(), (rs, i) -> new Recon.Finding(Recon.ALLOCATION_MISMATCH, "payment", Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("provider_payment_ref"),
            rs.getBigDecimal("expected"), rs.getBigDecimal("actual"), "Receipt " + rs.getString("short_id") + " brought in " + money(rs, "expected") + " but its bills and credit add up to " + money(rs, "actual"))));
        out.addAll(jdbc.query(BILLS, Map.of(), (rs, i) -> new Recon.Finding(Recon.BILL_PAID_MISMATCH, "due", Rows.uuid(rs, "id"), rs.getString("short_id"), null,
            rs.getBigDecimal("expected"), rs.getBigDecimal("actual"), "Bill " + rs.getString("short_id") + " shows " + money(rs, "actual") + " paid but receipts for it add up to " + money(rs, "expected"))));
        for (Map<String, Object> o : jdbc.query(ORDERS, Map.of(), (rs, i) -> row(rs))) {
            long n = ((Number) o.get("payments")).longValue();
            if (n > 1) out.add(new Recon.Finding(Recon.DUPLICATE_CAPTURE, "payment_order", (UUID) o.get("id"), (String) o.get("short_id"), (String) o.get("provider_order_ref"),
                (java.math.BigDecimal) o.get("expected"), (java.math.BigDecimal) o.get("actual"), "Order " + o.get("short_id") + " was paid " + n + " times - refund the extra or keep it as credit"));
            else out.add(new Recon.Finding(Recon.AMOUNT_MISMATCH, "payment_order", (UUID) o.get("id"), (String) o.get("short_id"), (String) o.get("provider_order_ref"),
                (java.math.BigDecimal) o.get("expected"), (java.math.BigDecimal) o.get("actual"), "Order " + o.get("short_id") + " was priced " + o.get("expected") + " but the provider captured " + o.get("actual")));
        }
        out.addAll(jdbc.query(REFUNDS, Map.of(), (rs, i) -> new Recon.Finding(Recon.REFUND_UNANSWERED, "gateway_refund", Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("provider_refund_ref"),
            rs.getBigDecimal("amount"), null, "Refund " + rs.getString("short_id") + " of " + money(rs, "amount") + " has had no answer from the payment provider for over an hour")));
        jdbc.query(LEDGER, Map.of(), (rs, i) -> {
            UUID c = Rows.uuid(rs, "id");
            if (rs.getBigDecimal("debit").compareTo(rs.getBigDecimal("credit")) != 0)
                out.add(new Recon.Finding(Recon.LEDGER_UNBALANCED, "ledger", c, null, null, rs.getBigDecimal("debit"), rs.getBigDecimal("credit"), "The books do not balance: debits " + money(rs, "debit") + ", credits " + money(rs, "credit")));
            if (rs.getBigDecimal("credit_held").compareTo(rs.getBigDecimal("credit_rows")) != 0)
                out.add(new Recon.Finding(Recon.CREDIT_MISMATCH, "ledger", c, null, null, rs.getBigDecimal("credit_rows"), rs.getBigDecimal("credit_held"),
                    "Units' credit adds up to " + money(rs, "credit_rows") + " but the unit-credit account holds " + money(rs, "credit_held")));
            return null;
        });
        out.addAll(jdbc.query(PAYOUTS, Map.of(), (rs, i) -> new Recon.Finding(Recon.PAYOUT_MISSING, "ledger", Rows.uuid(rs, "id"), null, null, rs.getBigDecimal("amount"), null,
            rs.getLong("n") + " online payment" + (rs.getLong("n") == 1 ? "" : "s") + " (" + money(rs, "amount") + ") received over a week ago are not matched to a payout on the bank statement")));
        return out;
    }
    @Override public boolean keep(Recon.Finding f) {
        Map<String, Object> p = new HashMap<>();
        p.put("kind", f.kind()); p.put("refType", f.refType()); p.put("refId", f.refId().toString()); p.put("refShort", f.refShortId()); p.put("providerRef", f.providerRef());
        p.put("expected", f.expected()); p.put("actual", f.actual()); p.put("detail", f.detail());
        return Boolean.TRUE.equals(jdbc.query(KEEP, p, (rs, i) -> rs.getBoolean("inserted")).stream().findFirst().orElse(false));
    }
    @Override public int clearAllBut(List<Recon.Finding> found) {
        return jdbc.update(CLEAR, Map.of("kinds", Recon.RECORD_CHECKS, "found", Rows.pgArray(found.stream().map((f) -> f.kind() + ":" + f.refId()).toList())));
    }
    @Override public List<Recon.Issue> issues(String status) { Map<String, Object> p = new HashMap<>(); p.put("status", status); return jdbc.query(LIST, p, (rs, i) -> issue(rs)); }
    @Override public Optional<Recon.Issue> issue(UUID id) { return jdbc.query(ONE, Map.of("id", id.toString()), (rs, i) -> issue(rs)).stream().findFirst(); }
    @Override public boolean resolve(UUID id, long version, String status, String note, UUID by, Instant at) {
        Map<String, Object> p = new HashMap<>(); p.put("id", id.toString()); p.put("version", version); p.put("status", status); p.put("note", note); p.put("by", by == null ? null : by.toString()); p.put("at", Rows.ts(at));
        return jdbc.update(RESOLVE, p) == 1;
    }

    static Recon.Issue issue(ResultSet rs) throws SQLException {
        return new Recon.Issue(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("kind"), rs.getString("ref_type"), Rows.uuid(rs, "ref_id"), rs.getString("ref_short_id"),
            rs.getString("provider_ref"), rs.getBigDecimal("expected"), rs.getBigDecimal("actual"), rs.getString("detail"), rs.getString("status"), rs.getString("note"),
            rs.getString("resolved_by_name"), Rows.instant(rs, "resolved_at"), Rows.instant(rs, "found_at"), Rows.instant(rs, "last_seen_at"), rs.getLong("version"));
    }
    private static Map<String, Object> row(ResultSet rs) throws SQLException {
        Map<String, Object> m = new HashMap<>();
        m.put("id", Rows.uuid(rs, "id")); m.put("short_id", rs.getString("short_id")); m.put("provider_order_ref", rs.getString("provider_order_ref"));
        m.put("expected", rs.getBigDecimal("expected")); m.put("actual", rs.getBigDecimal("actual")); m.put("payments", rs.getLong("payments"));
        return m;
    }
    private static String money(ResultSet rs, String col) throws SQLException { java.math.BigDecimal b = rs.getBigDecimal(col); return b == null ? "0" : b.toPlainString(); }
}
