package com.communityos.api.maintenance.adapter;

import com.communityos.api.maintenance.application.port.CommentRepository;
import com.communityos.api.maintenance.application.port.FieldStaffRepository;
import com.communityos.api.maintenance.application.port.MaintenanceDirectory;
import com.communityos.api.maintenance.domain.Comment;
import com.communityos.api.maintenance.domain.TaskType;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Task types, units, assignable people, final approvers, comments and the field staff register (tenant connection). */
public final class JdbcMaintenanceDirectory implements MaintenanceDirectory, CommentRepository, FieldStaffRepository {
    static final String TASK_TYPES = """
        SELECT id, name, icon, creator_scope, assignment_mode, quotation_stage, ec_approval_stage, treasurer_stage, invoice_stage, payment_stage, resident_visible,
               resident_default, active FROM maintenance.task_type ORDER BY resident_default DESC, name""";
    static final String UNIT = "SELECT id, unit_no, block_id FROM property.unit WHERE id = CAST(:id AS uuid) AND status = 'Active'";
    /** field staff of the trade + members in the category's coordinator roles (+ EC members for internal tasks), active members only */
    static final String CANDIDATES = """
        SELECT DISTINCT ON (m.id) m.id, m.display_name, x.kind, x.clocked_in, x.trade FROM (
            SELECT fs.membership_id AS mid, 'Field staff' AS kind, fs.clocked_in, fs.trade, 1 AS rank FROM maintenance.field_staff fs
             WHERE lower(fs.trade) = lower(:category) AND fs.membership_id IS NOT NULL AND NOT CAST(:internal AS boolean)
            UNION ALL
            SELECT mr.membership_id, 'Coordinator', false, r.trade, 2 FROM maintenance.category_coverage cc
              JOIN identity.role r ON r.community_id = cc.community_id AND (r.code = ANY (cc.coordinator)
                   OR ('group:EC' = ANY (cc.coordinator) AND EXISTS (SELECT 1 FROM identity.role_group g WHERE g.community_id = r.community_id AND g.id = r.group_id AND g.category = 'EC')))
              JOIN identity.membership_role mr ON mr.community_id = r.community_id AND mr.role_id = r.id
             WHERE lower(cc.category) = lower(:category)
            UNION ALL
            SELECT mr.membership_id, 'EC', false, NULL, 3 FROM identity.membership_role mr
              JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
              JOIN identity.role_group g ON g.community_id = r.community_id AND g.id = r.group_id AND g.category = 'EC'
             WHERE CAST(:internal AS boolean)) x
        JOIN identity.membership m ON m.id = x.mid AND m.status = 'Active'
        ORDER BY m.id, x.rank""";
    static final String APPROVERS = "SELECT roles FROM maintenance.approver_setting ORDER BY created_at LIMIT 1";
    static final String MEMBER = "SELECT display_name FROM identity.membership WHERE id = CAST(:id AS uuid) AND status = 'Active'";
    static final String COMMENTS = """
        SELECT c.id, c.short_id, c.ticket_id, c.author_id, m.display_name, c.visibility, c.body, c.created_at
        FROM maintenance.ticket_comment c JOIN identity.membership m ON m.community_id = c.community_id AND m.id = c.author_id
        WHERE c.ticket_id = CAST(:ticket AS uuid) AND (CAST(:internal AS boolean) OR c.visibility = 'Public') ORDER BY c.created_at, c.id""";
    static final String RECENT_COMMENTS = """
        SELECT c.id, c.short_id, c.ticket_id, c.author_id, m.display_name, c.visibility, c.body, c.created_at
        FROM maintenance.ticket_comment c
        JOIN identity.membership m ON m.community_id = c.community_id AND m.id = c.author_id
        JOIN maintenance.ticket t ON t.community_id = c.community_id AND t.id = c.ticket_id
        LEFT JOIN maintenance.task_type tt ON tt.community_id = t.community_id AND tt.id = t.task_type_id
        LEFT JOIN property.unit u ON u.community_id = t.community_id AND u.id = t.unit_id
        WHERE (CAST(:internal AS boolean) OR c.visibility = 'Public')""";
    public static String recentSql(String scopeSql) { return RECENT_COMMENTS + "\n  AND " + scopeSql + "\nORDER BY c.created_at DESC, c.id LIMIT :limit"; }
    static final String ADD_COMMENT = """
        WITH c AS (INSERT INTO maintenance.ticket_comment (community_id, ticket_id, author_id, author_role_id, visibility, body)
                   VALUES (platform.current_community(), CAST(:ticket AS uuid), CAST(:author AS uuid),
                           (SELECT mr.role_id FROM identity.membership_role mr WHERE mr.membership_id = CAST(:author AS uuid) AND mr.is_primary), :visibility, :body)
                   RETURNING id, short_id, ticket_id, author_id, visibility, body, created_at)
        SELECT c.id, c.short_id, c.ticket_id, c.author_id, m.display_name, c.visibility, c.body, c.created_at
        FROM c JOIN identity.membership m ON m.id = c.author_id""";
    static final String STAFF = "SELECT id, short_id, membership_id, name, trade, shift, phone, clocked_in, version FROM maintenance.field_staff";
    static final String STAFF_ALL = STAFF + " ORDER BY trade, name";
    static final String STAFF_ONE = STAFF + " WHERE id = CAST(:id AS uuid)";
    static final String STAFF_ADD = """
        INSERT INTO maintenance.field_staff (community_id, membership_id, name, trade, shift, phone, clocked_in)
        VALUES (platform.current_community(), CAST(:member AS uuid), :name, :trade, :shift, :phone, false)
        RETURNING id, short_id, membership_id, name, trade, shift, phone, clocked_in, version""";
    static final String STAFF_CLOCK = "UPDATE maintenance.field_staff SET clocked_in = :in WHERE id = CAST(:id AS uuid) AND version = :version";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcMaintenanceDirectory(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public List<TaskType> taskTypes() {
        return jdbc.query(TASK_TYPES, Map.of(), (rs, i) -> new TaskType(Rows.uuid(rs, "id"), rs.getString("name"), rs.getString("icon"), rs.getString("creator_scope"),
            rs.getString("assignment_mode"), rs.getString("quotation_stage"), rs.getString("ec_approval_stage"), rs.getString("treasurer_stage"), rs.getString("invoice_stage"),
            rs.getString("payment_stage"), rs.getBoolean("resident_visible"), rs.getBoolean("resident_default"), rs.getBoolean("active")));
    }
    @Override public Optional<TaskType> taskType(UUID id) { return taskTypes().stream().filter((t) -> t.id().equals(id)).findFirst(); }
    @Override public Optional<UnitRef> unit(UnitId id) {
        return jdbc.query(UNIT, Map.of("id", id.toString()), (rs, i) -> { UUID b = Rows.uuid(rs, "block_id"); return new UnitRef(new UnitId(Rows.uuid(rs, "id")), rs.getString("unit_no"), b == null ? null : new BlockId(b)); })
            .stream().findFirst();
    }
    @Override public List<Candidate> candidates(String category, boolean internal) {
        return jdbc.query(CANDIDATES, Map.of("category", category, "internal", internal), (rs, i) -> new Candidate(new MembershipId(Rows.uuid(rs, "id")), rs.getString("display_name"),
            rs.getString("kind"), rs.getBoolean("clocked_in"), rs.getString("trade"))).stream().sorted(java.util.Comparator.comparing(Candidate::kind).thenComparing(Candidate::name)).toList();
    }
    @Override public Set<String> finalApproverRoles() {
        Set<String> r = jdbc.query(APPROVERS, Map.of(), (rs, i) -> Rows.set(rs, "roles", String::valueOf)).stream().findFirst().orElse(Set.of());
        return r.isEmpty() ? Set.of("treasurer", "president") : new LinkedHashSet<>(r);
    }
    @Override public Optional<String> memberName(MembershipId id) { return jdbc.query(MEMBER, Map.of("id", id.toString()), (rs, i) -> rs.getString("display_name")).stream().findFirst(); }

    @Override public List<Comment> ofTicket(UUID ticket, boolean internal) { return jdbc.query(COMMENTS, Map.of("ticket", ticket.toString(), "internal", internal), (rs, i) -> comment(rs)); }
    @Override public List<Comment> recent(com.communityos.api.shared.access.Spec<com.communityos.api.maintenance.domain.Ticket> scope, boolean internal, int limit) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("internal", internal); p.put("limit", Math.min(Math.max(limit, 1), 1000));
        return jdbc.query(recentSql(scope.sql()), p, (rs, i) -> comment(rs));
    }
    @Override public Comment insert(UUID ticket, MembershipId author, String visibility, String body) {
        return jdbc.query(ADD_COMMENT, Map.of("ticket", ticket.toString(), "author", author.toString(), "visibility", visibility, "body", body), (rs, i) -> comment(rs)).get(0);
    }
    private static Comment comment(ResultSet rs) throws SQLException {
        return new Comment(Rows.uuid(rs, "id"), rs.getString("short_id"), Rows.uuid(rs, "ticket_id"), new MembershipId(Rows.uuid(rs, "author_id")), rs.getString("display_name"),
            rs.getString("visibility"), rs.getString("body"), Rows.instant(rs, "created_at"));
    }

    @Override public List<FieldStaff> all() { return jdbc.query(STAFF_ALL, Map.of(), (rs, i) -> staff(rs)); }
    @Override public Optional<FieldStaff> byId(UUID id) { return jdbc.query(STAFF_ONE, Map.of("id", id.toString()), (rs, i) -> staff(rs)).stream().findFirst(); }
    @Override public FieldStaff insert(MembershipId member, String name, String trade, String shift, String phone) {
        Map<String, Object> p = new HashMap<>(); p.put("member", member.toString()); p.put("name", name); p.put("trade", trade); p.put("shift", shift); p.put("phone", phone);
        return jdbc.query(STAFF_ADD, p, (rs, i) -> staff(rs)).get(0);
    }
    @Override public boolean setClockedIn(UUID id, boolean in, long version) { return jdbc.update(STAFF_CLOCK, Map.of("id", id.toString(), "in", in, "version", version)) == 1; }
    private static FieldStaff staff(ResultSet rs) throws SQLException {
        UUID m = Rows.uuid(rs, "membership_id");
        return new FieldStaff(Rows.uuid(rs, "id"), rs.getString("short_id"), m == null ? null : new MembershipId(m), rs.getString("name"), rs.getString("trade"), rs.getString("shift"),
            rs.getString("phone"), rs.getBoolean("clocked_in"), rs.getLong("version"));
    }
}
