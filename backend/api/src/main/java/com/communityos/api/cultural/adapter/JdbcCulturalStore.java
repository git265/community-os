package com.communityos.api.cultural.adapter;

import com.communityos.api.approval.application.PlanCodec;
import com.communityos.api.approval.domain.Plan;
import com.communityos.api.cultural.application.port.CulturalStore;
import com.communityos.api.cultural.domain.Cultural;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The cultural module's records on the tenant connection. Event totals are aggregates over the rows, never stored values. */
public final class JdbcCulturalStore implements CulturalStore {
    // ---- events ----------------------------------------------------------------------------------------------------------------------------------
    /** Spent = approved and paid expenses of the event. */
    public static final String SPENT = "(SELECT coalesce(sum(x.amount), 0) FROM cultural.expense x WHERE x.community_id = r.community_id AND x.event_id = r.id AND x.status IN ('Approved', 'Paid'))";
    public static final String COLLECTED = "(SELECT coalesce(sum(d.amount), 0) FROM cultural.donation d WHERE d.community_id = r.community_id AND d.event_id = r.id AND d.status = 'Received')";
    public static final String PLEDGED = "(SELECT coalesce(sum(d.amount), 0) FROM cultural.donation d WHERE d.community_id = r.community_id AND d.event_id = r.id AND d.status = 'Pledged')";
    public static final String FAMILIES = "(SELECT count(DISTINCT coalesce(d.unit_id::text, lower(d.donor))) FROM cultural.donation d WHERE d.community_id = r.community_id AND d.event_id = r.id)";
    public static final String DONORS = "(SELECT count(DISTINCT coalesce(d.unit_id::text, lower(d.donor))) FROM cultural.donation d WHERE d.community_id = r.community_id AND d.event_id = r.id AND d.status = 'Received')";
    static final String EVENT = "SELECT r.id, r.name, r.start_date, r.status, r.visibility, r.final_over, r.fund, r.budget, " + SPENT + " AS spent, r.historical_actual, r.credited_amount, r.version"
        + "\nFROM cultural.event r WHERE r.id = CAST(:id AS uuid)";
    static final String EVENT_LOCK = EVENT + " FOR UPDATE OF r";
    static final String CREDIT = """
        UPDATE cultural.event SET credited_amount = :amount, credited_at = now(), credited_by_id = platform.current_actor(), credit_note = :note
        WHERE id = CAST(:id AS uuid) AND version = :version""";

    // ---- donations -------------------------------------------------------------------------------------------------------------------------------
    static final String DONATION_COLUMNS = """
        SELECT d.id, d.short_id, d.event_id, d.donor, d.unit_id, u.unit_no, d.kind, d.towards, d.amount, d.date, d.mode, d.reference, d.status, d.receipt_no, d.offering_id, d.phone,
               d.members, d.sankalpam, d.anonymous, d.note, d.pledged_by_id, d.received_by_id, m.display_name AS received_by, d.received_at, d.payment_id, d.created_at, d.version
        FROM cultural.donation d LEFT JOIN property.unit u ON u.community_id = d.community_id AND u.id = d.unit_id
        LEFT JOIN identity.membership m ON m.community_id = d.community_id AND m.id = d.received_by_id""";
    public static String donationsSql(String scope) {
        return DONATION_COLUMNS + "\nWHERE (" + scope + ") AND (CAST(:event AS uuid) IS NULL OR d.event_id = CAST(:event AS uuid))\nORDER BY d.date DESC NULLS LAST, d.created_at DESC LIMIT 5000";
    }
    public static String donationSql(String scope) { return DONATION_COLUMNS + "\nWHERE d.id = CAST(:id AS uuid) AND (" + scope + ")"; }
    static final String DONATION_INSERT = """
        INSERT INTO cultural.donation (community_id, id, event_id, donor, unit_id, kind, towards, amount, date, mode, reference, status, offering_id, phone, members, sankalpam,
                                       anonymous, note, pledged_by_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:event AS uuid), :donor, CAST(:unit AS uuid), :kind, :towards, :amount, CAST(:date AS date), :mode, :reference,
                'Pledged', CAST(:offering AS uuid), :phone, :members, :sankalpam, :anonymous, :note, CAST(:pledgedBy AS uuid))
        RETURNING short_id, version, created_at""";
    static final String DONATION_UPDATE = """
        UPDATE cultural.donation SET donor = :donor, kind = :kind, towards = :towards, amount = :amount, date = CAST(:date AS date), mode = :mode, reference = :reference, status = :status,
               receipt_no = :receipt, phone = :phone, members = :members, sankalpam = :sankalpam, anonymous = :anonymous, note = :note, received_by_id = CAST(:receivedBy AS uuid),
               received_at = CAST(:receivedAt AS timestamptz), payment_id = CAST(:payment AS uuid), payment_claimed_at = CASE WHEN CAST(:payment AS uuid) IS NULL THEN NULL ELSE now() END
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String DONATION_DELETE = "DELETE FROM cultural.donation WHERE id = CAST(:id AS uuid) AND version = :version AND status = 'Pledged'";
    static final String LAST_RECEIPT = """
        SELECT coalesce(max(CAST(substring(d.receipt_no FROM '-([0-9]+)$') AS integer)), 0) AS n FROM cultural.donation d WHERE d.receipt_no LIKE :prefix""";

    // ---- offerings -------------------------------------------------------------------------------------------------------------------------------
    static final String OFFERING = "SELECT o.id, o.event_id, o.title, o.day, o.kind, o.pledge_value, o.donation_id FROM cultural.offering o WHERE o.id = CAST(:id AS uuid)";
    static final String RESERVE = """
        UPDATE cultural.offering SET donation_id = CAST(:donation AS uuid), reserved_by = :by, reserved_unit_id = CAST(:unit AS uuid),
               reserved_unit = (SELECT u.unit_no FROM property.unit u WHERE u.id = CAST(:unit AS uuid)), reserved_at = now()
        WHERE id = CAST(:id AS uuid) AND kind = 'Fixed slot' AND donation_id IS NULL""";
    static final String RELEASE = """
        UPDATE cultural.offering SET donation_id = NULL, reserved_by = NULL, reserved_unit_id = NULL, reserved_unit = NULL, reserved_at = NULL WHERE donation_id = CAST(:donation AS uuid)""";

    // ---- expenses --------------------------------------------------------------------------------------------------------------------------------
    static final String EXPENSE_COLUMNS = """
        SELECT x.id, x.short_id, x.event_id, x.item, x.category, x.vendor, x.amount, x.estimate, x.date, x.status, x.fund, x.plan, x.note, x.raised_by_id, rb.display_name AS raised_by,
               x.paid_by_id, pb.display_name AS paid_by, x.paid_at, x.paid_mode, x.created_at, x.version
        FROM cultural.expense x LEFT JOIN identity.membership rb ON rb.community_id = x.community_id AND rb.id = x.raised_by_id
        LEFT JOIN identity.membership pb ON pb.community_id = x.community_id AND pb.id = x.paid_by_id""";
    static final String EXPENSES = EXPENSE_COLUMNS + "\nWHERE (CAST(:event AS uuid) IS NULL OR x.event_id = CAST(:event AS uuid)) ORDER BY x.date DESC NULLS LAST, x.created_at DESC LIMIT 5000";
    static final String EXPENSE = EXPENSE_COLUMNS + "\nWHERE x.id = CAST(:id AS uuid)";
    static final String EXPENSE_INSERT = """
        INSERT INTO cultural.expense (community_id, id, event_id, item, category, vendor, amount, estimate, date, status, fund, plan, note, raised_by_id, ec_approval, final_required)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:event AS uuid), :item, :category, :vendor, :amount, :estimate, CAST(:date AS date), :status, :fund, :plan, :note,
                CAST(:raisedBy AS uuid), :ecApproval, coalesce(CAST(:finalRequired AS boolean), false))
        RETURNING short_id, version, created_at""";
    static final String EXPENSE_UPDATE = """
        UPDATE cultural.expense SET item = :item, category = :category, vendor = :vendor, amount = :amount, estimate = :estimate, date = CAST(:date AS date), status = :status, fund = :fund,
               plan = :plan, note = :note, ec_approval = :ecApproval, ec_approved_by_id = CAST(:ecBy AS uuid), ec_approved_at = CAST(:ecAt AS timestamptz), ec_note = :ecNote,
               final_required = coalesce(CAST(:finalRequired AS boolean), false), approved_by_id = CAST(:approvedBy AS uuid), approved_at = CAST(:approvedAt AS timestamptz), approval_note = :approvalNote,
               paid_by_id = CAST(:paidBy AS uuid), paid_at = CAST(:paidAt AS timestamptz), paid_mode = :paidMode
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String EXPENSE_DELETE = "DELETE FROM cultural.expense WHERE id = CAST(:id AS uuid) AND version = :version AND status IN ('Pending approval', 'Rejected')";

    // ---- sign-ups --------------------------------------------------------------------------------------------------------------------------------
    static final String SEVA = "SELECT s.id, s.event_id, s.title, coalesce(s.needed, 0) AS lim, 0 AS ppu, s.volunteers::text AS list, s.version FROM cultural.seva s WHERE s.id = CAST(:id AS uuid)";
    static final String PROGRAM = """
        SELECT p.id, p.event_id, p.title, coalesce(p.capacity, 0) AS lim, coalesce(nullif(p.people_per_unit, 0), CAST(e.default_people AS integer), 0) AS ppu, p.participants::text AS list, p.version
        FROM cultural.program p JOIN cultural.event e ON e.community_id = p.community_id AND e.id = p.event_id WHERE p.id = CAST(:id AS uuid)""";
    static final String SEVA_SAVE = "UPDATE cultural.seva SET volunteers = CAST(:list AS jsonb) WHERE id = CAST(:id AS uuid)";
    static final String PROGRAM_SAVE = "UPDATE cultural.program SET participants = CAST(:list AS jsonb) WHERE id = CAST(:id AS uuid)";
    static final String PHOTO_OWNER = "SELECT e.visibility = 'Published' AS published, x.uploaded_by_id AS added_by FROM cultural.photo x JOIN cultural.event e ON e.community_id = x.community_id AND e.id = x.event_id WHERE x.id = CAST(:id AS uuid)";
    static final String BROCHURE_OWNER = "SELECT e.visibility = 'Published' AS published, NULL::uuid AS added_by FROM cultural.brochure_page x JOIN cultural.event e ON e.community_id = x.community_id AND e.id = x.event_id WHERE x.id = CAST(:id AS uuid)";
    static final String UNIT_NO = "SELECT u.unit_no FROM property.unit u WHERE u.id = CAST(:id AS uuid)";

    private final NamedParameterJdbcTemplate jdbc; private final PlanCodec plans; private final ObjectMapper json;
    public JdbcCulturalStore(NamedParameterJdbcTemplate jdbc, PlanCodec plans, ObjectMapper json) { this.jdbc = jdbc; this.plans = plans; this.json = json; }

    @Override public Optional<Cultural.Event> event(UUID id, boolean lock) {
        return jdbc.query(lock ? EVENT_LOCK : EVENT, Map.of("id", id.toString()), (rs, i) -> new Cultural.Event(Rows.uuid(rs, "id"), rs.getString("name"), Rows.date(rs, "start_date"),
            rs.getString("status"), rs.getString("visibility"), rs.getBigDecimal("final_over"), rs.getString("fund"), rs.getBigDecimal("budget"), rs.getBigDecimal("spent"),
            rs.getBigDecimal("historical_actual"), rs.getBigDecimal("credited_amount"), rs.getLong("version"))).stream().findFirst();
    }
    @Override public boolean credit(UUID eventId, long version, BigDecimal amount, String note) {
        Map<String, Object> p = new HashMap<>(); p.put("id", eventId.toString()); p.put("version", version); p.put("amount", amount); p.put("note", note);
        return jdbc.update(CREDIT, p) == 1;
    }

    @Override public List<Cultural.Donation> donations(Spec<Cultural.Donation> scope, UUID eventId) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("event", eventId == null ? null : eventId.toString());
        return jdbc.query(donationsSql(scope.sql()), p, (rs, i) -> donation(rs));
    }
    @Override public Optional<Cultural.Donation> donation(UUID id, Spec<Cultural.Donation> scope) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString());
        return jdbc.query(donationSql(scope.sql()), p, (rs, i) -> donation(rs)).stream().findFirst();
    }
    @Override public void insert(Cultural.Donation d) {
        if (d.id == null) d.id = UUID.randomUUID();
        jdbc.query(DONATION_INSERT, params(d), (rs, i) -> { d.shortId = rs.getString("short_id"); d.version = rs.getLong("version"); d.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Cultural.Donation d) {
        List<Long> v = jdbc.query(DONATION_UPDATE, params(d), (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        d.version = v.get(0); return true;
    }
    @Override public boolean delete(UUID id, long version) { return jdbc.update(DONATION_DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    @Override public int lastReceipt(String code) {
        return jdbc.query(LAST_RECEIPT, Map.of("prefix", code.replace("%", "").replace("_", "\\_") + "-%"), (rs, i) -> rs.getInt("n")).stream().findFirst().orElse(0);
    }

    @Override public Optional<Offering> offering(UUID id) {
        return jdbc.query(OFFERING, Map.of("id", id.toString()), (rs, i) -> new Offering(Rows.uuid(rs, "id"), Rows.uuid(rs, "event_id"), rs.getString("title"), rs.getString("day"),
            rs.getString("kind"), rs.getBigDecimal("pledge_value"), Rows.uuid(rs, "donation_id"))).stream().findFirst();
    }
    @Override public boolean reserve(UUID offeringId, UUID donationId, String by, UUID unitId) {
        Map<String, Object> p = new HashMap<>(); p.put("id", offeringId.toString()); p.put("donation", donationId.toString()); p.put("by", by); p.put("unit", unitId == null ? null : unitId.toString());
        return jdbc.update(RESERVE, p) == 1;
    }
    @Override public void release(UUID donationId) { jdbc.update(RELEASE, Map.of("donation", donationId.toString())); }

    @Override public List<Cultural.Expense> expenses(UUID eventId) { Map<String, Object> p = new HashMap<>(); p.put("event", eventId == null ? null : eventId.toString()); return jdbc.query(EXPENSES, p, (rs, i) -> expense(rs)); }
    @Override public Optional<Cultural.Expense> expense(UUID id) { return jdbc.query(EXPENSE, Map.of("id", id.toString()), (rs, i) -> expense(rs)).stream().findFirst(); }
    @Override public void insert(Cultural.Expense x) {
        if (x.id == null) x.id = UUID.randomUUID();
        jdbc.query(EXPENSE_INSERT, params(x), (rs, i) -> { x.shortId = rs.getString("short_id"); x.version = rs.getLong("version"); x.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Cultural.Expense x) {
        List<Long> v = jdbc.query(EXPENSE_UPDATE, params(x), (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        x.version = v.get(0); return true;
    }
    @Override public boolean deleteExpense(UUID id, long version) { return jdbc.update(EXPENSE_DELETE, Map.of("id", id.toString(), "version", version)) == 1; }

    @Override public Optional<Slot> slot(List_ which, UUID id, boolean lock) {
        String sql = (which == List_.SEVA ? SEVA : PROGRAM) + (lock ? (which == List_.SEVA ? " FOR UPDATE OF s" : " FOR UPDATE OF p") : "");
        return jdbc.query(sql, Map.of("id", id.toString()), (rs, i) -> new Slot(Rows.uuid(rs, "id"), Rows.uuid(rs, "event_id"), rs.getString("title"), rs.getInt("lim"), rs.getInt("ppu"),
            signups(rs.getString("list")), rs.getLong("version"))).stream().findFirst();
    }
    @Override public boolean saveList(List_ which, UUID id, List<Cultural.Signup> list) {
        try { return jdbc.update(which == List_.SEVA ? SEVA_SAVE : PROGRAM_SAVE, Map.of("id", id.toString(), "list", json.writeValueAsString(list))) == 1; }
        catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException(e); }
    }
    @Override public String unitNo(UUID unitId) { return jdbc.query(UNIT_NO, Map.of("id", unitId.toString()), (rs, i) -> rs.getString("unit_no")).stream().findFirst().orElse(null); }

    @Override public Optional<Owner> photo(UUID id) { return jdbc.query(PHOTO_OWNER, Map.of("id", id.toString()), (rs, i) -> new Owner(rs.getBoolean("published"), Rows.uuid(rs, "added_by"))).stream().findFirst(); }
    @Override public Optional<Owner> brochure(UUID id) { return jdbc.query(BROCHURE_OWNER, Map.of("id", id.toString()), (rs, i) -> new Owner(rs.getBoolean("published"), null)).stream().findFirst(); }

    // ---- rows ------------------------------------------------------------------------------------------------------------------------------------
    List<Cultural.Signup> signups(String s) {
        try {
            List<Map<String, Object>> raw = json.readValue(s == null ? "[]" : s, new TypeReference<List<Map<String, Object>>>() {});
            return raw.stream().map((m) -> new Cultural.Signup(m.get("membershipId") == null ? null : UUID.fromString(String.valueOf(m.get("membershipId"))), str(m.get("name")),
                str(m.get("unit")), m.get("people") == null ? null : ((Number) m.get("people")).intValue())).toList();
        } catch (Exception e) { return List.of(); }
    }
    static String str(Object o) { return o == null ? null : String.valueOf(o); }
    static Cultural.Donation donation(ResultSet rs) throws SQLException {
        Cultural.Donation d = new Cultural.Donation();
        d.id = Rows.uuid(rs, "id"); d.shortId = rs.getString("short_id"); d.eventId = Rows.uuid(rs, "event_id"); d.donor = rs.getString("donor"); d.unitId = Rows.uuid(rs, "unit_id");
        d.unitNo = rs.getString("unit_no"); d.kind = rs.getString("kind"); d.towards = rs.getString("towards"); d.amount = rs.getBigDecimal("amount"); d.date = Rows.date(rs, "date");
        d.mode = rs.getString("mode"); d.reference = rs.getString("reference"); d.status = rs.getString("status"); d.receiptNo = rs.getString("receipt_no"); d.offeringId = Rows.uuid(rs, "offering_id");
        d.phone = rs.getString("phone"); d.members = rs.getString("members"); d.sankalpam = rs.getString("sankalpam"); d.anonymous = rs.getBoolean("anonymous"); d.note = rs.getString("note");
        d.pledgedById = Rows.uuid(rs, "pledged_by_id"); d.receivedById = Rows.uuid(rs, "received_by_id"); d.receivedBy = rs.getString("received_by"); d.receivedAt = Rows.instant(rs, "received_at");
        d.paymentId = Rows.uuid(rs, "payment_id"); d.createdAt = Rows.instant(rs, "created_at"); d.version = rs.getLong("version");
        return d;
    }
    static Map<String, Object> params(Cultural.Donation d) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", d.id.toString()); p.put("event", d.eventId.toString()); p.put("donor", d.donor); p.put("unit", s(d.unitId)); p.put("kind", d.kind); p.put("towards", d.towards);
        p.put("amount", d.amount); p.put("date", d.date == null ? null : d.date.toString()); p.put("mode", d.mode); p.put("reference", d.reference); p.put("status", d.status);
        p.put("receipt", d.receiptNo); p.put("offering", s(d.offeringId)); p.put("phone", d.phone); p.put("members", d.members); p.put("sankalpam", d.sankalpam); p.put("anonymous", d.anonymous);
        p.put("note", d.note); p.put("pledgedBy", s(d.pledgedById)); p.put("receivedBy", s(d.receivedById)); p.put("receivedAt", d.receivedAt == null ? null : d.receivedAt.toString());
        p.put("payment", s(d.paymentId)); p.put("version", d.version);
        return p;
    }
    Cultural.Expense expense(ResultSet rs) throws SQLException {
        Cultural.Expense x = new Cultural.Expense();
        x.id = Rows.uuid(rs, "id"); x.shortId = rs.getString("short_id"); x.eventId = Rows.uuid(rs, "event_id"); x.item = rs.getString("item"); x.category = rs.getString("category");
        x.vendor = rs.getString("vendor"); x.amount = rs.getBigDecimal("amount"); x.estimate = rs.getBigDecimal("estimate"); x.date = Rows.date(rs, "date"); x.status = rs.getString("status");
        x.fund = rs.getString("fund"); x.plan = rs.getString("plan") == null ? null : plans.read(rs.getString("plan")); x.note = rs.getString("note"); x.raisedById = Rows.uuid(rs, "raised_by_id");
        x.raisedBy = rs.getString("raised_by"); x.paidById = Rows.uuid(rs, "paid_by_id"); x.paidBy = rs.getString("paid_by"); x.paidAt = Rows.instant(rs, "paid_at"); x.paidMode = rs.getString("paid_mode");
        x.createdAt = Rows.instant(rs, "created_at"); x.version = rs.getLong("version");
        x.mirror();
        return x;
    }
    Map<String, Object> params(Cultural.Expense x) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", x.id.toString()); p.put("event", x.eventId.toString()); p.put("item", x.item); p.put("category", x.category); p.put("vendor", x.vendor); p.put("amount", x.amount);
        p.put("estimate", x.estimate); p.put("date", x.date == null ? null : x.date.toString()); p.put("status", x.status); p.put("fund", x.fund); p.put("plan", plans.write(x.plan));
        p.put("note", x.note); p.put("raisedBy", s(x.raisedById)); p.put("ecApproval", x.ecApproval); p.put("finalRequired", x.finalRequired);
        Plan.Slots sl = x.plan == null ? null : x.plan.slots();
        p.put("ecBy", sl == null || sl.ecLast() == null ? null : uuidOrNull(sl.ecLast().by())); p.put("ecAt", x.ecApprovedAt == null ? null : x.ecApprovedAt.toString()); p.put("ecNote", x.ecNote);
        Plan.Decision last = sl == null ? null : sl.finLast() != null ? sl.finLast() : sl.ecLast();
        p.put("approvedBy", x.approvedBy == null || last == null ? null : uuidOrNull(last.by())); p.put("approvedAt", x.approvedAt == null ? null : x.approvedAt.toString());
        p.put("approvalNote", x.approvalNote); p.put("paidBy", s(x.paidById)); p.put("paidAt", x.paidAt == null ? null : x.paidAt.toString()); p.put("paidMode", x.paidMode); p.put("version", x.version);
        return p;
    }
    static String uuidOrNull(String s) { try { return s == null ? null : UUID.fromString(s).toString(); } catch (IllegalArgumentException e) { return null; } }
    static String s(Object o) { return o == null ? null : o.toString(); }
}
