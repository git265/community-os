package com.communityos.api.maintenance.adapter;

import com.communityos.api.approval.application.PlanCodec;
import com.communityos.api.maintenance.application.port.QuotationRepository;
import com.communityos.api.maintenance.application.port.TaskMoney;
import com.communityos.api.maintenance.domain.Quotation;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.jdbc.Rows;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** maintenance.quotation on the tenant connection, the money summary on maintenance.ticket, and the task's money position from finance. */
public final class JdbcQuotationRepository implements QuotationRepository, TaskMoney {
    static final String COLUMNS = """
        SELECT q.id, q.short_id, q.ticket_id, q.kind, q.vendor, q.amount, q.base_amount, q.gst_mode, q.gst_rate, q.gst_amount, q.quote_date, q.note, q.selected, q.over_budget,
               q.plan, q.ec_approval, q.ec_approved_by_id, q.ec_approved_at, q.final_required, q.final_approval, q.final_approved_by_id, q.final_approved_at, q.approval_waived,
               q.correction_note, q.created_by, m.display_name AS created_by_name, q.created_at, q.updated_at, q.version
        FROM maintenance.quotation q
        LEFT JOIN identity.membership m ON m.community_id = q.community_id AND m.id = q.created_by""";
    static final String OF_TICKET = COLUMNS + "\nWHERE q.ticket_id = CAST(:ticket AS uuid) ORDER BY q.created_at, q.id";
    static final String GET = COLUMNS + "\nWHERE q.id = CAST(:id AS uuid)";
    static final String INSERT = """
        INSERT INTO maintenance.quotation (community_id, id, ticket_id, kind, vendor, amount, base_amount, gst_mode, gst_rate, gst_amount, quote_date, note, selected,
                                           over_budget, plan, ec_approval, ec_approved_by_id, ec_approved_at, final_required, final_approval, final_approved_by_id,
                                           final_approved_at, approval_waived, correction_note)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:ticket AS uuid), :kind, :vendor, :amount, :base, :gstMode, :gstRate, :gst, CAST(:quoteDate AS date), :note,
                :selected, :overBudget, :plan, :ec, CAST(:ecBy AS uuid), CAST(:ecAt AS timestamptz), :finalRequired, :fin, CAST(:finBy AS uuid), CAST(:finAt AS timestamptz),
                :waived, :correction)
        RETURNING short_id, version, created_at""";
    static final String UPDATE = """
        UPDATE maintenance.quotation SET selected = :selected, plan = :plan, ec_approval = :ec, ec_approved_by_id = CAST(:ecBy AS uuid), ec_approved_at = CAST(:ecAt AS timestamptz),
               final_required = :finalRequired, final_approval = :fin, final_approved_by_id = CAST(:finBy AS uuid), final_approved_at = CAST(:finAt AS timestamptz),
               approval_waived = :waived, correction_note = :correction
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String DELETE = "DELETE FROM maintenance.quotation WHERE id = CAST(:id AS uuid) AND version = :version";
    static final String TICKET_APPROVAL = """
        UPDATE maintenance.ticket SET quotation_status = :qs, invoice_status = :is, approved_amount = :approved, selected_quotation_id = CAST(:quote AS uuid),
               selected_invoice_id = CAST(:invoice AS uuid), ec_approval = :ec, treasurer_approval = :fin, final_required = :finalRequired
        WHERE id = CAST(:ticket AS uuid)""";
    /** live debits = payments that count: not internal bookkeeping and not reversed */
    static final String LIVE = """
        SELECT l.id, l.source_id, coalesce(l.amount, 0) + coalesce(l.tds_amount, 0) AS gross
        FROM finance.cash_book_entry l
        WHERE l.type = 'Debit' AND NOT l.internal
          AND NOT EXISTS (SELECT 1 FROM finance.cash_book_entry x WHERE x.community_id = l.community_id AND x.reversal_of IN (l.id::text, l.short_id))""";
    static final String POSITION = """
        WITH tk AS (SELECT id, short_id, approved_amount, quotation_status FROM maintenance.ticket WHERE id = CAST(:ticket AS uuid)),
             docs AS (SELECT id, kind, selected, amount, approval_waived, ec_approval, final_required, final_approval FROM maintenance.quotation WHERE ticket_id = CAST(:ticket AS uuid)),
             rel AS (SELECT id, status, amount FROM finance.release WHERE ticket_id = CAST(:ticket AS uuid)),
             live AS (SELECT lv.* FROM (""" + LIVE + """
                     ) lv, tk WHERE lv.source_id = tk.id OR lv.source_id IN (SELECT id FROM docs) OR lv.source_id IN (SELECT id FROM rel)
                        OR lv.id IN (SELECT e.id FROM finance.cash_book_entry e WHERE e.task_ref = tk.short_id))
        SELECT coalesce((SELECT sum(amount) FROM docs WHERE kind = 'Invoice' AND selected
                         AND (approval_waived OR (ec_approval = 'Approved' AND (NOT final_required OR final_approval = 'Approved')))), 0) AS inv_approved,
               coalesce((SELECT CASE WHEN quotation_status = 'Approved' THEN approved_amount END FROM tk), 0) AS quoted,
               coalesce((SELECT sum(amount) FROM rel WHERE status NOT IN ('Rejected', 'Cancelled')), 0) AS released,
               coalesce((SELECT sum(gross) FROM live WHERE source_id IS NULL OR source_id NOT IN (SELECT id FROM rel)), 0) AS direct,
               coalesce((SELECT sum(gross) FROM live), 0) AS paid,
               (SELECT count(*) FROM rel WHERE status IN ('Waiting approval', 'Approved')) AS open_releases""";
    static final String PAID_ON = "SELECT coalesce(sum(lv.gross), 0) AS paid FROM (" + LIVE + ") lv WHERE lv.source_id = CAST(:doc AS uuid)";

    public static String allSql(String ticketScopeSql) {
        return COLUMNS + "\nJOIN maintenance.ticket t ON t.community_id = q.community_id AND t.id = q.ticket_id"
            + "\nLEFT JOIN maintenance.task_type tt ON tt.community_id = t.community_id AND tt.id = t.task_type_id"
            + "\nLEFT JOIN property.unit u ON u.community_id = t.community_id AND u.id = t.unit_id"
            + "\nWHERE " + ticketScopeSql + "\nORDER BY q.created_at DESC, q.id LIMIT 2000";
    }

    private final NamedParameterJdbcTemplate jdbc; private final PlanCodec plans;
    public JdbcQuotationRepository(NamedParameterJdbcTemplate jdbc, PlanCodec plans) { this.jdbc = jdbc; this.plans = plans; }

    @Override public List<Quotation> ofTicket(UUID ticketId) { return jdbc.query(OF_TICKET, Map.of("ticket", ticketId.toString()), (rs, i) -> map(rs)); }
    @Override public List<Quotation> all(Spec<Ticket> scope) { return jdbc.query(allSql(scope.sql()), new HashMap<>(scope.params()), (rs, i) -> map(rs)); }
    @Override public Optional<Quotation> get(UUID id) { return jdbc.query(GET, Map.of("id", id.toString()), (rs, i) -> map(rs)).stream().findFirst(); }
    @Override public void insert(Quotation q) {
        Quotation.State s = q.state();
        Map<String, Object> p = slots(s);
        p.put("id", s.id.toString()); p.put("ticket", s.ticketId.toString()); p.put("kind", s.kind); p.put("vendor", s.vendor); p.put("amount", s.amount.amount());
        p.put("base", s.baseAmount.amount()); p.put("gstMode", s.gstMode); p.put("gstRate", s.gstRate); p.put("gst", s.gstAmount == null ? null : s.gstAmount.amount());
        p.put("quoteDate", Rows.sqlDate(s.quoteDate)); p.put("note", s.note); p.put("overBudget", s.overBudget);
        jdbc.query(INSERT, p, (rs, i) -> { s.shortId = rs.getString("short_id"); s.version = rs.getLong("version"); s.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean save(Quotation q) {
        Quotation.State s = q.state();
        Map<String, Object> p = slots(s); p.put("id", s.id.toString()); p.put("version", s.version);
        List<Long> v = jdbc.query(UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        s.version = v.get(0);
        return true;
    }
    @Override public boolean delete(UUID id, long version) { return jdbc.update(DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    @Override public void saveTicketApproval(UUID ticketId, Ticket.Approval a) {
        Map<String, Object> p = new HashMap<>();
        p.put("ticket", ticketId.toString()); p.put("qs", a.quotationStatus()); p.put("is", a.invoiceStatus()); p.put("approved", a.approvedAmount() == null ? null : a.approvedAmount().amount());
        p.put("quote", a.selectedQuotationId() == null ? null : a.selectedQuotationId().toString()); p.put("invoice", a.selectedInvoiceId() == null ? null : a.selectedInvoiceId().toString());
        p.put("ec", a.ecApproval()); p.put("fin", a.treasurerApproval()); p.put("finalRequired", Boolean.TRUE.equals(a.finalRequired()));
        jdbc.update(TICKET_APPROVAL, p);
    }

    @Override public Position position(UUID ticketId) {
        return jdbc.query(POSITION, Map.of("ticket", ticketId.toString()), (rs, i) -> {
            BigDecimal inv = rs.getBigDecimal("inv_approved"), quoted = rs.getBigDecimal("quoted"), released = rs.getBigDecimal("released"), direct = rs.getBigDecimal("direct");
            String basis = inv.signum() > 0 ? "Invoice" : quoted.signum() > 0 ? "Quotation" : "None";
            BigDecimal cap = inv.signum() > 0 ? inv : quoted;
            BigDecimal committed = released.add(direct);
            Money remaining = cap.signum() > 0 ? new Money(cap.subtract(committed).max(BigDecimal.ZERO)) : null;
            return new Position(basis, new Money(cap), new Money(inv), new Money(quoted), new Money(released), new Money(direct), new Money(rs.getBigDecimal("paid")),
                new Money(committed), remaining, rs.getInt("open_releases"));
        }).get(0);
    }
    @Override public Money paidOn(UUID documentId) { return new Money(jdbc.queryForObject(PAID_ON, Map.of("doc", documentId.toString()), BigDecimal.class)); }

    private Map<String, Object> slots(Quotation.State s) {
        Map<String, Object> p = new HashMap<>();
        p.put("selected", s.selected); p.put("plan", plans.write(s.plan)); p.put("ec", s.ecApproval); p.put("ecBy", s.ecApprovedBy == null ? null : s.ecApprovedBy.toString());
        p.put("ecAt", Rows.ts(s.ecApprovedAt)); p.put("finalRequired", s.finalRequired); p.put("fin", s.finalApproval);
        p.put("finBy", s.finalApprovedBy == null ? null : s.finalApprovedBy.toString()); p.put("finAt", Rows.ts(s.finalApprovedAt)); p.put("waived", s.approvalWaived);
        p.put("correction", s.correctionNote);
        return p;
    }
    private Quotation map(ResultSet rs) throws SQLException {
        Quotation.State s = new Quotation.State();
        s.id = Rows.uuid(rs, "id"); s.shortId = rs.getString("short_id"); s.ticketId = Rows.uuid(rs, "ticket_id"); s.kind = rs.getString("kind"); s.vendor = rs.getString("vendor");
        s.amount = Rows.money(rs, "amount"); s.baseAmount = Rows.money(rs, "base_amount"); s.gstMode = rs.getString("gst_mode"); s.gstRate = rs.getBigDecimal("gst_rate");
        s.gstAmount = Rows.money(rs, "gst_amount"); s.quoteDate = Rows.date(rs, "quote_date"); s.note = rs.getString("note"); s.selected = rs.getBoolean("selected");
        s.overBudget = rs.getBoolean("over_budget"); s.plan = plans.read(rs.getString("plan")); s.ecApproval = rs.getString("ec_approval"); s.ecApprovedBy = Rows.uuid(rs, "ec_approved_by_id");
        s.ecApprovedAt = Rows.instant(rs, "ec_approved_at"); s.finalRequired = rs.getBoolean("final_required"); s.finalApproval = rs.getString("final_approval");
        s.finalApprovedBy = Rows.uuid(rs, "final_approved_by_id"); s.finalApprovedAt = Rows.instant(rs, "final_approved_at"); s.approvalWaived = rs.getBoolean("approval_waived");
        s.correctionNote = rs.getString("correction_note"); s.createdBy = Rows.uuid(rs, "created_by"); s.createdByName = rs.getString("created_by_name");
        s.createdAt = Rows.instant(rs, "created_at"); s.updatedAt = Rows.instant(rs, "updated_at"); s.version = rs.getLong("version");
        return new Quotation(s);
    }
}
