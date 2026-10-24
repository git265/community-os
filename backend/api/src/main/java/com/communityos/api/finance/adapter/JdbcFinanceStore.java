package com.communityos.api.finance.adapter;

import com.communityos.api.approval.application.PlanCodec;
import com.communityos.api.finance.application.port.FinanceStore;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.shared.jdbc.Rows;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Finance beyond bills on the tenant connection. */
public final class JdbcFinanceStore implements FinanceStore {
    static final String SETTINGS = "SELECT coalesce(s.approval_limit, 0) AS approval_limit, s.locked_until, coalesce(s.approval_separate, false) AS separate FROM finance.finance_setting s LIMIT 1";
    static final String LOCK = "UPDATE finance.finance_setting SET locked_until = CAST(:until AS date)";

    // ---- the cash book -------------------------------------------------------------------------------------------------------------------------
    static final String ENTRY_COLUMNS = """
        SELECT l.id, l.short_id, l.date, l.account, l.description, l.category, l.sub_category, l.type, l.amount, l.vendor, l.task_ref, l.no_task, l.module, l.source_type,
               l.source_label, l.source_id, l.mode, l.ref, l.unit_id, u.unit_no, l.booking_no, l.invoice_no, l.bill_no, l.base_amount, l.gst_rate, l.gst_amount, l.tds_section,
               l.tds_rate, l.tds_amount, l.fund, l.itc_status, l.itc_note, l.internal, l.reversal_of, l.reason, l.recon_status, l.bank_txn_id, l.entered_by_id,
               m.display_name AS entered_by, EXISTS (SELECT 1 FROM finance.cash_book_entry x WHERE x.community_id = l.community_id AND x.reversal_of IN (l.short_id, l.id::text)) AS reversed,
               l.created_at, l.version
        FROM finance.cash_book_entry l LEFT JOIN property.unit u ON u.community_id = l.community_id AND u.id = l.unit_id
        LEFT JOIN identity.membership m ON m.community_id = l.community_id AND m.id = l.entered_by_id""";
    static final String ENTRIES = ENTRY_COLUMNS + """

        WHERE (CAST(:from AS date) IS NULL OR l.date >= CAST(:from AS date)) AND (CAST(:to AS date) IS NULL OR l.date <= CAST(:to AS date))
          AND (CAST(:module AS text) IS NULL OR l.module = :module) AND (CAST(:recon AS text) IS NULL OR l.recon_status = :recon)
          AND (CAST(:task AS text) IS NULL OR l.task_ref = :task) AND (CAST(:source AS uuid) IS NULL OR l.source_id = CAST(:source AS uuid))
        ORDER BY l.date DESC, l.created_at DESC LIMIT 5000""";
    static final String ENTRY = ENTRY_COLUMNS + "\nWHERE l.id = CAST(:id AS uuid)";
    static final String ENTRY_INSERT = """
        INSERT INTO finance.cash_book_entry (community_id, id, date, account, description, category, sub_category, type, amount, vendor, task_ref, no_task, module, source_type,
                                             source_label, source_id, mode, ref, unit_id, booking_no, invoice_no, bill_no, base_amount, gst_rate, gst_amount, tds_section, tds_rate,
                                             tds_amount, fund, itc_status, itc_note, internal, reversal_of, reason, recon_status, entered_by_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:date AS date), :account, :description, :category, :subCategory, :type, :amount, :vendor, :taskRef, :noTask,
                :module, :sourceType, :sourceLabel, CAST(:sourceId AS uuid), :mode, :ref, CAST(:unit AS uuid), :bookingNo, :invoiceNo, :billNo, :base, :gstRate, :gst, :tdsSection,
                :tdsRate, :tds, :fund, :itcStatus, :itcNote, :internal, :reversalOf, :reason, :recon, platform.current_actor())
        RETURNING short_id, version, created_at""";
    static final String ANNOTATE = """
        UPDATE finance.cash_book_entry SET description = :description, category = :category, sub_category = :subCategory, itc_status = :itcStatus, itc_note = :itcNote,
               itc_checked_at = CASE WHEN CAST(:itcStatus AS text) IS DISTINCT FROM itc_status THEN now() ELSE itc_checked_at END
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String RECON = "UPDATE finance.cash_book_entry SET recon_status = :status, bank_txn_id = CAST(:txn AS uuid) WHERE id = CAST(:id AS uuid)";

    // ---- releases ------------------------------------------------------------------------------------------------------------------------------
    static final String RELEASE_COLUMNS = """
        SELECT r.id, r.short_id, r.ticket_id, t.short_id AS ticket_no, r.expense_id, r.kind, r.amount, r.vendor, r.note, r.status, r.cancel_reason, r.cancelled_by_id, r.cancelled_at,
               r.raised_by_id, m.display_name AS raised_by, r.plan, r.paid_at, r.paid_entry_id, r.created_at, r.version
        FROM finance.release r LEFT JOIN maintenance.ticket t ON t.community_id = r.community_id AND t.id = r.ticket_id
        LEFT JOIN identity.membership m ON m.community_id = r.community_id AND m.id = r.raised_by_id""";
    static final String RELEASES = RELEASE_COLUMNS + """

        WHERE (CAST(:ticket AS uuid) IS NULL OR r.ticket_id = CAST(:ticket AS uuid)) AND (CAST(:expense AS uuid) IS NULL OR r.expense_id = CAST(:expense AS uuid))
        ORDER BY r.created_at DESC LIMIT 2000""";
    static final String RELEASE = RELEASE_COLUMNS + "\nWHERE r.id = CAST(:id AS uuid)";
    static final String RELEASE_INSERT = """
        INSERT INTO finance.release (community_id, id, ticket_id, ticket_short_id, expense_id, kind, amount, vendor, note, status, requested_by, raised_by_id, plan, settled)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:ticket AS uuid), (SELECT t.short_id FROM maintenance.ticket t WHERE t.id = CAST(:ticket AS uuid)), CAST(:expense AS uuid),
                :kind, :amount, :vendor, :note, :status, :requestedBy, platform.current_actor(), :plan, false)
        RETURNING short_id, version, created_at""";
    static final String RELEASE_UPDATE = """
        UPDATE finance.release SET kind = :kind, amount = :amount, vendor = :vendor, note = :note, status = :status, plan = :plan, cancel_reason = :cancelReason,
               cancelled_by_id = CAST(:cancelledBy AS uuid), cancelled_at = CAST(:cancelledAt AS timestamptz), paid_at = CAST(:paidAt AS timestamptz), paid_entry_id = CAST(:paidEntry AS uuid),
               settled = :settled
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String RELEASE_UNPAID = "UPDATE finance.release SET status = 'Approved', paid_at = NULL, paid_entry_id = NULL, settled = false WHERE id = CAST(:id AS uuid) AND status = 'Paid'";
    static final String RELEASE_DELETE = "DELETE FROM finance.release WHERE id = CAST(:id AS uuid) AND version = :version AND status IN ('Waiting approval', 'Rejected')";
    static final String EXPENSE_MONEY = """
        SELECT x.id, x.event_id, x.item, x.status, coalesce(x.amount, x.estimate, 0) AS amount,
               coalesce((SELECT sum(r.amount) FROM finance.release r WHERE r.community_id = x.community_id AND r.expense_id = x.id AND r.status NOT IN ('Rejected', 'Cancelled')), 0) AS released,
               coalesce((SELECT sum(r.amount) FROM finance.release r WHERE r.community_id = x.community_id AND r.expense_id = x.id AND r.status = 'Paid'), 0) AS paid
        FROM cultural.expense x WHERE x.id = CAST(:id AS uuid)""";
    /** Paid = its live (not reversed) cash-book payments, with the tax withheld from them, plus its paid releases cover the amount. */
    static final String EXPENSE_SETTLE = """
        UPDATE cultural.expense x SET status = CASE WHEN s.covered THEN 'Paid' ELSE 'Approved' END,
               paid_at = CASE WHEN s.covered THEN now() END, paid_by_id = CASE WHEN s.covered THEN platform.current_actor() END,
               paid_mode = CASE WHEN s.covered THEN CAST(:how AS text) END
        FROM (SELECT y.id, (coalesce(y.amount, 0) > 0 AND
                coalesce((SELECT sum(e.amount + coalesce(e.tds_amount, 0)) FROM finance.cash_book_entry e
                          WHERE e.community_id = y.community_id AND e.source_type = 'culturalExpense' AND e.source_id = y.id AND e.type = 'Debit' AND e.reversal_of IS NULL
                            AND NOT EXISTS (SELECT 1 FROM finance.cash_book_entry r WHERE r.community_id = e.community_id AND r.reversal_of IN (e.short_id, e.id::text))), 0)
              + coalesce((SELECT sum(r.amount) FROM finance.release r WHERE r.community_id = y.community_id AND r.expense_id = y.id AND r.status = 'Paid'), 0) + 0.5 >= y.amount) AS covered
              FROM cultural.expense y WHERE y.id = CAST(:id AS uuid)) s
        WHERE x.id = s.id AND x.status IN ('Approved', 'Paid') AND (x.status = 'Paid') IS DISTINCT FROM s.covered""";
    static final String RELEASE_EXPENSE = "SELECT expense_id FROM finance.release WHERE id = CAST(:id AS uuid) AND expense_id IS NOT NULL";

    // ---- pay requests --------------------------------------------------------------------------------------------------------------------------
    static final String PAY_COLUMNS = """
        SELECT p.id, p.short_id, p.description, p.amount, p.vendor, p.status, p.requested_by_id, rq.display_name AS requested_by, p.decided_by_id, dc.display_name AS decided_by, p.decided_at,
               p.decision_note, p.payload::text AS payload, p.entry_id, p.created_at, p.version
        FROM finance.pay_request p LEFT JOIN identity.membership rq ON rq.community_id = p.community_id AND rq.id = p.requested_by_id
        LEFT JOIN identity.membership dc ON dc.community_id = p.community_id AND dc.id = p.decided_by_id""";
    static final String PAYS = PAY_COLUMNS + "\nWHERE (CAST(:status AS text) IS NULL OR p.status = :status) ORDER BY p.created_at DESC LIMIT 1000";
    static final String PAY = PAY_COLUMNS + "\nWHERE p.id = CAST(:id AS uuid)";
    static final String PAY_INSERT = """
        INSERT INTO finance.pay_request (community_id, id, description, amount, vendor, requested_by, status, payload, requested_by_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), :description, :amount, :vendor, :requestedBy, 'Waiting', CAST(:payload AS jsonb), platform.current_actor())
        RETURNING short_id, version, created_at""";
    static final String PAY_UPDATE = """
        UPDATE finance.pay_request SET status = :status, decided_by_id = platform.current_actor(), decided_at = now(), decision_note = :note, entry_id = CAST(:entry AS uuid)
        WHERE id = CAST(:id AS uuid) AND version = :version AND status = 'Waiting' RETURNING version""";

    // ---- the bank ------------------------------------------------------------------------------------------------------------------------------
    static final String LINE_COLUMNS = "SELECT b.id, b.short_id, b.date, b.account, b.narration, b.head, b.debit, b.credit, b.balance, b.party, b.remarks, b.matched_ledger_id, b.version FROM finance.bank_txn b";
    static final String LINES = LINE_COLUMNS + """

        WHERE (CAST(:account AS text) IS NULL OR b.account = :account) AND (CAST(:from AS date) IS NULL OR b.date >= CAST(:from AS date))
          AND (CAST(:to AS date) IS NULL OR b.date <= CAST(:to AS date)) AND (CAST(:unmatched AS boolean) IS NOT TRUE OR b.matched_ledger_id IS NULL)
        ORDER BY b.date DESC, b.created_at DESC LIMIT 10000""";
    static final String LINE = LINE_COLUMNS + "\nWHERE b.id = CAST(:id AS uuid)";
    static final String LINE_INSERT = """
        INSERT INTO finance.bank_txn (community_id, date, account, narration, head, debit, credit, balance, party, remarks, imported_by_id, line_hash)
        VALUES (platform.current_community(), CAST(:date AS date), :account, :narration, :head, :debit, :credit, :balance, :party, :remarks, platform.current_actor(), :hash)
        ON CONFLICT (community_id, line_hash) DO NOTHING""";
    static final String MATCH = "UPDATE finance.bank_txn SET matched_ledger_id = CAST(:entry AS uuid) WHERE id = CAST(:id AS uuid) AND matched_ledger_id IS NULL";
    static final String UNMATCH = "UPDATE finance.bank_txn SET matched_ledger_id = NULL WHERE id = CAST(:id AS uuid) AND matched_ledger_id IS NOT NULL";

    // ---- the ledger ----------------------------------------------------------------------------------------------------------------------------
    static final String ACCOUNTS = """
        SELECT a.id, a.code, a.name, a.kind, a.is_bank, coalesce(b.debit, 0) AS debit, coalesce(b.credit, 0) AS credit, coalesce(b.debit, 0) - coalesce(b.credit, 0) AS balance
        FROM finance.account a
        LEFT JOIN (SELECT l.account_id, sum(l.debit) AS debit, sum(l.credit) AS credit FROM finance.journal_line l
                   JOIN finance.journal_entry e ON e.community_id = l.community_id AND e.id = l.entry_id AND e.status = 'Posted' GROUP BY l.account_id) b ON b.account_id = a.id
        WHERE a.active ORDER BY a.code""";
    static final String JOURNAL = """
        SELECT e.id, e.short_id, e.entry_date, e.memo, e.source_type, e.source_id, a.code, a.name, l.unit_id, l.debit, l.credit, l.narration
        FROM finance.journal_entry e JOIN finance.journal_line l ON l.community_id = e.community_id AND l.entry_id = e.id
        JOIN finance.account a ON a.community_id = l.community_id AND a.id = l.account_id
        WHERE e.status = 'Posted' AND (CAST(:from AS date) IS NULL OR e.entry_date >= CAST(:from AS date)) AND (CAST(:to AS date) IS NULL OR e.entry_date <= CAST(:to AS date))
          AND (CAST(:account AS text) IS NULL OR EXISTS (SELECT 1 FROM finance.journal_line l2 JOIN finance.account a2 ON a2.community_id = l2.community_id AND a2.id = l2.account_id
                                                         WHERE l2.community_id = e.community_id AND l2.entry_id = e.id AND a2.code = :account))
        ORDER BY e.entry_date DESC, e.created_at DESC, l.line_no LIMIT 20000""";

    private final NamedParameterJdbcTemplate jdbc; private final PlanCodec plans;
    public JdbcFinanceStore(NamedParameterJdbcTemplate jdbc, PlanCodec plans) { this.jdbc = jdbc; this.plans = plans; }

    @Override public Settings settings() {
        return jdbc.query(SETTINGS, Map.of(), (rs, i) -> new Settings(rs.getBigDecimal("approval_limit"), Rows.date(rs, "locked_until"), rs.getBoolean("separate"))).stream().findFirst()
            .orElse(new Settings(BigDecimal.ZERO, null, false));
    }
    @Override public boolean lock(LocalDate until) { Map<String, Object> p = new HashMap<>(); p.put("until", until == null ? null : until.toString()); return jdbc.update(LOCK, p) >= 1; }

    @Override public List<Books.Entry> entries(EntryFilter f) {
        Map<String, Object> p = new HashMap<>();
        p.put("from", s(f.from())); p.put("to", s(f.to())); p.put("module", f.module()); p.put("recon", f.recon()); p.put("task", f.taskRef()); p.put("source", s(f.sourceId()));
        return jdbc.query(ENTRIES, p, (rs, i) -> entry(rs));
    }
    @Override public Optional<Books.Entry> entry(UUID id) { return jdbc.query(ENTRY, Map.of("id", id.toString()), (rs, i) -> entry(rs)).stream().findFirst(); }
    @Override public void insert(Books.Entry e) {
        if (e.id == null) e.id = UUID.randomUUID();
        Map<String, Object> p = new HashMap<>();
        p.put("id", e.id.toString()); p.put("date", e.date.toString()); p.put("account", e.account); p.put("description", e.description); p.put("category", e.category);
        p.put("subCategory", e.subCategory); p.put("type", e.type); p.put("amount", e.amount); p.put("vendor", e.vendor); p.put("taskRef", e.taskRef); p.put("noTask", e.noTask);
        p.put("module", e.module); p.put("sourceType", e.sourceType); p.put("sourceLabel", e.sourceLabel); p.put("sourceId", s(e.sourceId)); p.put("mode", e.mode); p.put("ref", e.ref);
        p.put("unit", s(e.unitId)); p.put("bookingNo", e.bookingNo); p.put("invoiceNo", e.invoiceNo); p.put("billNo", e.billNo); p.put("base", e.baseAmount); p.put("gstRate", e.gstRate);
        p.put("gst", e.gstAmount); p.put("tdsSection", e.tdsSection); p.put("tdsRate", e.tdsRate); p.put("tds", e.tdsAmount); p.put("fund", e.fund); p.put("itcStatus", e.itcStatus);
        p.put("itcNote", e.itcNote); p.put("internal", e.internal); p.put("reversalOf", e.reversalOf); p.put("reason", e.reason); p.put("recon", e.reconStatus);
        jdbc.query(ENTRY_INSERT, p, (rs, i) -> { e.shortId = rs.getString("short_id"); e.version = rs.getLong("version"); e.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean annotate(Books.Entry e) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", e.id.toString()); p.put("version", e.version); p.put("description", e.description); p.put("category", e.category); p.put("subCategory", e.subCategory);
        p.put("itcStatus", e.itcStatus); p.put("itcNote", e.itcNote);
        List<Long> v = jdbc.query(ANNOTATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        e.version = v.get(0); return true;
    }
    @Override public boolean setRecon(UUID entryId, String status, UUID bankTxnId) {
        Map<String, Object> p = new HashMap<>(); p.put("id", entryId.toString()); p.put("status", status); p.put("txn", s(bankTxnId));
        return jdbc.update(RECON, p) == 1;
    }

    @Override public List<Books.Release> releases(UUID ticketId, UUID expenseId) {
        Map<String, Object> p = new HashMap<>(); p.put("ticket", s(ticketId)); p.put("expense", s(expenseId));
        return jdbc.query(RELEASES, p, (rs, i) -> release(rs));
    }
    @Override public Optional<Books.Release> release(UUID id) { return jdbc.query(RELEASE, Map.of("id", id.toString()), (rs, i) -> release(rs)).stream().findFirst(); }
    @Override public void insert(Books.Release r) {
        if (r.id == null) r.id = UUID.randomUUID();
        Map<String, Object> p = new HashMap<>();
        p.put("id", r.id.toString()); p.put("ticket", s(r.ticketId)); p.put("expense", s(r.expenseId)); p.put("kind", r.kind); p.put("amount", r.amount); p.put("vendor", r.vendor);
        p.put("note", r.note); p.put("status", r.status); p.put("requestedBy", r.raisedBy); p.put("plan", plans.write(r.plan));
        jdbc.query(RELEASE_INSERT, p, (rs, i) -> { r.shortId = rs.getString("short_id"); r.version = rs.getLong("version"); r.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Books.Release r) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", r.id.toString()); p.put("version", r.version); p.put("kind", r.kind); p.put("amount", r.amount); p.put("vendor", r.vendor); p.put("note", r.note); p.put("status", r.status);
        p.put("plan", plans.write(r.plan)); p.put("cancelReason", r.cancelReason); p.put("cancelledBy", s(r.cancelledById)); p.put("cancelledAt", s(r.cancelledAt));
        p.put("paidAt", s(r.paidAt)); p.put("paidEntry", s(r.paidEntryId)); p.put("settled", "Paid".equals(r.status));
        List<Long> v = jdbc.query(RELEASE_UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        r.version = v.get(0); return true;
    }
    @Override public void releaseUnpaid(UUID releaseId) { jdbc.update(RELEASE_UNPAID, Map.of("id", releaseId.toString())); }
    @Override public boolean deleteRelease(UUID id, long version) { return jdbc.update(RELEASE_DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    @Override public Optional<ExpenseMoney> expenseMoney(UUID expenseId) {
        return jdbc.query(EXPENSE_MONEY, Map.of("id", expenseId.toString()), (rs, i) -> new ExpenseMoney(Rows.uuid(rs, "id"), Rows.uuid(rs, "event_id"), rs.getString("item"), rs.getString("status"),
            rs.getBigDecimal("amount"), rs.getBigDecimal("released"), rs.getBigDecimal("paid"))).stream().findFirst();
    }
    @Override public void settleExpense(UUID expenseId, String how) {
        var p = new java.util.HashMap<String, Object>(); p.put("id", expenseId.toString()); p.put("how", how);
        jdbc.update(EXPENSE_SETTLE, p);
    }
    @Override public Optional<UUID> releaseExpense(UUID releaseId) {
        return jdbc.query(RELEASE_EXPENSE, Map.of("id", releaseId.toString()), (rs, i) -> Rows.uuid(rs, "expense_id")).stream().findFirst();
    }

    @Override public List<Books.PayRequest> payRequests(String status) { Map<String, Object> p = new HashMap<>(); p.put("status", status); return jdbc.query(PAYS, p, (rs, i) -> pay(rs)); }
    @Override public Optional<Books.PayRequest> payRequest(UUID id) { return jdbc.query(PAY, Map.of("id", id.toString()), (rs, i) -> pay(rs)).stream().findFirst(); }
    @Override public void insert(Books.PayRequest x) {
        if (x.id == null) x.id = UUID.randomUUID();
        Map<String, Object> p = new HashMap<>();
        p.put("id", x.id.toString()); p.put("description", x.description); p.put("amount", x.amount); p.put("vendor", x.vendor); p.put("requestedBy", x.requestedBy); p.put("payload", x.payload);
        jdbc.query(PAY_INSERT, p, (rs, i) -> { x.shortId = rs.getString("short_id"); x.version = rs.getLong("version"); x.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Books.PayRequest x) {
        Map<String, Object> p = new HashMap<>(); p.put("id", x.id.toString()); p.put("version", x.version); p.put("status", x.status); p.put("note", x.decisionNote); p.put("entry", s(x.entryId));
        List<Long> v = jdbc.query(PAY_UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        x.version = v.get(0); return true;
    }

    @Override public List<Books.BankLine> bankLines(LineFilter f) {
        Map<String, Object> p = new HashMap<>(); p.put("account", f.account()); p.put("from", s(f.from())); p.put("to", s(f.to())); p.put("unmatched", f.unmatched());
        return jdbc.query(LINES, p, (rs, i) -> line(rs));
    }
    @Override public Optional<Books.BankLine> bankLine(UUID id) { return jdbc.query(LINE, Map.of("id", id.toString()), (rs, i) -> line(rs)).stream().findFirst(); }
    @Override public int importLines(List<Books.BankLine> lines) {
        int n = 0;
        for (Books.BankLine l : lines) {
            Map<String, Object> p = new HashMap<>();
            p.put("date", l.date().toString()); p.put("account", l.account()); p.put("narration", l.narration()); p.put("head", l.head()); p.put("debit", l.debit() == null ? BigDecimal.ZERO : l.debit());
            p.put("credit", l.credit() == null ? BigDecimal.ZERO : l.credit()); p.put("balance", l.balance()); p.put("party", l.party()); p.put("remarks", l.remarks());
            p.put("hash", hash(l));
            n += jdbc.update(LINE_INSERT, p);
        }
        return n;
    }
    @Override public boolean match(UUID lineId, UUID entryId) { return jdbc.update(MATCH, Map.of("id", lineId.toString(), "entry", entryId.toString())) == 1; }
    @Override public boolean unmatch(UUID lineId) { return jdbc.update(UNMATCH, Map.of("id", lineId.toString())) == 1; }

    @Override public List<AccountBalance> accounts() {
        return jdbc.query(ACCOUNTS, Map.of(), (rs, i) -> new AccountBalance(Rows.uuid(rs, "id"), rs.getString("code"), rs.getString("name"), rs.getString("kind"), rs.getBoolean("is_bank"),
            rs.getBigDecimal("debit"), rs.getBigDecimal("credit"), rs.getBigDecimal("balance")));
    }
    @Override public List<JournalEntry> journal(LocalDate from, LocalDate to, String accountCode) {
        Map<String, Object> p = new HashMap<>(); p.put("from", s(from)); p.put("to", s(to)); p.put("account", accountCode);
        Map<UUID, Object[]> by = new LinkedHashMap<>();
        jdbc.query(JOURNAL, p, (rs, i) -> {
            UUID id = Rows.uuid(rs, "id");
            Object[] e = by.computeIfAbsent(id, (k) -> { try { return new Object[] {rs.getString("short_id"), Rows.date(rs, "entry_date"), rs.getString("memo"), rs.getString("source_type"), Rows.uuid(rs, "source_id"), new ArrayList<JournalLine>()}; } catch (SQLException x) { throw new IllegalStateException(x); } });
            @SuppressWarnings("unchecked") List<JournalLine> ls = (List<JournalLine>) e[5];
            ls.add(new JournalLine(rs.getString("code"), rs.getString("name"), Rows.uuid(rs, "unit_id"), rs.getBigDecimal("debit"), rs.getBigDecimal("credit"), rs.getString("narration")));
            return null;
        });
        List<JournalEntry> out = new ArrayList<>();
        for (var en : by.entrySet()) { Object[] e = en.getValue(); @SuppressWarnings("unchecked") List<JournalLine> ls = (List<JournalLine>) e[5];
            out.add(new JournalEntry(en.getKey(), (String) e[0], (LocalDate) e[1], (String) e[2], (String) e[3], (UUID) e[4], ls)); }
        return out;
    }

    // ---- rows ------------------------------------------------------------------------------------------------------------------------------------
    static Books.Entry entry(ResultSet rs) throws SQLException {
        Books.Entry e = new Books.Entry();
        e.id = Rows.uuid(rs, "id"); e.shortId = rs.getString("short_id"); e.date = Rows.date(rs, "date"); e.account = rs.getString("account"); e.description = rs.getString("description");
        e.category = rs.getString("category"); e.subCategory = rs.getString("sub_category"); e.type = rs.getString("type"); e.amount = rs.getBigDecimal("amount"); e.vendor = rs.getString("vendor");
        e.taskRef = rs.getString("task_ref"); e.noTask = rs.getString("no_task"); e.module = rs.getString("module"); e.sourceType = rs.getString("source_type"); e.sourceLabel = rs.getString("source_label");
        e.sourceId = Rows.uuid(rs, "source_id"); e.mode = rs.getString("mode"); e.ref = rs.getString("ref"); e.unitId = Rows.uuid(rs, "unit_id"); e.unitNo = rs.getString("unit_no");
        e.bookingNo = rs.getString("booking_no"); e.invoiceNo = rs.getString("invoice_no"); e.billNo = rs.getString("bill_no"); e.baseAmount = rs.getBigDecimal("base_amount");
        e.gstRate = rs.getBigDecimal("gst_rate"); e.gstAmount = rs.getBigDecimal("gst_amount"); e.tdsSection = rs.getString("tds_section"); e.tdsRate = rs.getBigDecimal("tds_rate");
        e.tdsAmount = rs.getBigDecimal("tds_amount"); e.fund = rs.getString("fund"); e.itcStatus = rs.getString("itc_status"); e.itcNote = rs.getString("itc_note"); e.internal = rs.getBoolean("internal");
        e.reversalOf = rs.getString("reversal_of"); e.reason = rs.getString("reason"); e.reconStatus = rs.getString("recon_status"); e.bankTxnId = Rows.uuid(rs, "bank_txn_id");
        e.enteredById = Rows.uuid(rs, "entered_by_id"); e.enteredBy = rs.getString("entered_by"); e.reversed = rs.getBoolean("reversed"); e.createdAt = Rows.instant(rs, "created_at"); e.version = rs.getLong("version");
        return e;
    }
    Books.Release release(ResultSet rs) throws SQLException {
        Books.Release r = new Books.Release();
        r.id = Rows.uuid(rs, "id"); r.shortId = rs.getString("short_id"); r.ticketId = Rows.uuid(rs, "ticket_id"); r.ticketShortId = rs.getString("ticket_no"); r.expenseId = Rows.uuid(rs, "expense_id");
        r.kind = rs.getString("kind"); r.amount = rs.getBigDecimal("amount"); r.vendor = rs.getString("vendor"); r.note = rs.getString("note"); r.status = rs.getString("status");
        r.cancelReason = rs.getString("cancel_reason"); r.cancelledById = Rows.uuid(rs, "cancelled_by_id"); r.cancelledAt = Rows.instant(rs, "cancelled_at"); r.raisedById = Rows.uuid(rs, "raised_by_id");
        r.raisedBy = rs.getString("raised_by"); r.plan = rs.getString("plan") == null || rs.getString("plan").isBlank() ? null : plans.read(rs.getString("plan")); r.paidAt = Rows.instant(rs, "paid_at");
        r.paidEntryId = Rows.uuid(rs, "paid_entry_id"); r.createdAt = Rows.instant(rs, "created_at"); r.version = rs.getLong("version");
        return r;
    }
    static Books.PayRequest pay(ResultSet rs) throws SQLException {
        Books.PayRequest x = new Books.PayRequest();
        x.id = Rows.uuid(rs, "id"); x.shortId = rs.getString("short_id"); x.description = rs.getString("description"); x.amount = rs.getBigDecimal("amount"); x.vendor = rs.getString("vendor");
        x.status = rs.getString("status"); x.requestedById = Rows.uuid(rs, "requested_by_id"); x.requestedBy = rs.getString("requested_by"); x.decidedById = Rows.uuid(rs, "decided_by_id");
        x.decidedBy = rs.getString("decided_by"); x.decidedAt = Rows.instant(rs, "decided_at"); x.decisionNote = rs.getString("decision_note"); x.payload = rs.getString("payload");
        x.entryId = Rows.uuid(rs, "entry_id"); x.createdAt = Rows.instant(rs, "created_at"); x.version = rs.getLong("version");
        return x;
    }
    static Books.BankLine line(ResultSet rs) throws SQLException {
        return new Books.BankLine(Rows.uuid(rs, "id"), rs.getString("short_id"), Rows.date(rs, "date"), rs.getString("account"), rs.getString("narration"), rs.getString("head"),
            rs.getBigDecimal("debit"), rs.getBigDecimal("credit"), rs.getBigDecimal("balance"), rs.getString("party"), rs.getString("remarks"), Rows.uuid(rs, "matched_ledger_id"), rs.getLong("version"));
    }
    static String s(Object o) { return o == null ? null : o.toString(); }
    /** The same statement line (account, date, narration, amounts, running balance) always hashes the same, so it is imported once. */
    static String hash(Books.BankLine l) {
        String key = String.join("|", l.account(), l.date().toString(), String.valueOf(l.narration()), plain(l.debit()), plain(l.credit()), plain(l.balance()));
        try { return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(key.getBytes(java.nio.charset.StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    static String plain(BigDecimal b) { return b == null || b.signum() == 0 ? "0" : b.stripTrailingZeros().toPlainString(); }
}
