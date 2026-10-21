package com.communityos.api.identity.adapter;

import com.communityos.api.identity.application.port.MemberRepository;
import com.communityos.api.identity.domain.MemberView;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Members on the tenant connection: every statement is limited to the caller's community by RLS, and by the access Spec on top. */
public final class JdbcMemberRepository implements MemberRepository {
    static final String SELECT = """
        SELECT m.id, m.person_id, m.display_name, p.phone_e164, m.status, m.created_at, m.updated_at, m.version,
               COALESCE((SELECT json_agg(json_build_object('code', r.code, 'name', r.name, 'primary', mr.is_primary) ORDER BY mr.is_primary DESC, r.code)::text
                           FROM identity.membership_role mr JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                          WHERE mr.community_id = m.community_id AND mr.membership_id = m.id), '[]') AS roles,
               ARRAY(SELECT o.unit_id FROM property.occupant o WHERE o.community_id = m.community_id AND o.person_id = m.person_id AND o.to_date IS NULL) AS units,
               count(*) OVER () AS total
        FROM identity.membership m JOIN identity.person p ON p.id = m.person_id""";
    static final String FILTER = """
         WHERE (CAST(:q AS text) IS NULL OR m.display_name ILIKE :q ESCAPE '\\' OR p.phone_e164 LIKE :q ESCAPE '\\')
           AND (CAST(:status AS text) IS NULL OR m.status = :status)
           AND (CAST(:role AS text) IS NULL OR EXISTS (SELECT 1 FROM identity.membership_role mr JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                                                     WHERE mr.community_id = m.community_id AND mr.membership_id = m.id AND r.code = :role))""";
    public static String listSql(String scopeSql) { return SELECT + "\n" + FILTER + "\n  AND " + scopeSql + "\nORDER BY m.display_name, m.id LIMIT :limit OFFSET :offset"; }
    public static String getSql(String scopeSql) { return SELECT + "\nWHERE m.id = CAST(:id AS uuid) AND " + scopeSql; }
    static final String INSERT = "INSERT INTO identity.membership (community_id, person_id, display_name, status, joined_on) VALUES (platform.current_community(), CAST(:person AS uuid), :name, 'Active', current_date) RETURNING id";
    static final String BUMP = "UPDATE identity.membership SET display_name = display_name WHERE id = CAST(:id AS uuid) AND version = :version";
    static final String CLEAR_ROLES = "DELETE FROM identity.membership_role WHERE membership_id = CAST(:id AS uuid)";
    static final String ADD_ROLE = "INSERT INTO identity.membership_role (community_id, membership_id, role_id, is_primary) VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:role AS uuid), :primary)";
    static final String STATUS = "UPDATE identity.membership SET status = :status, left_on = CASE WHEN CAST(:status AS text) = 'Inactive' THEN current_date END WHERE id = CAST(:id AS uuid) AND version = :version";
    static final String OCCUPANT = """
        INSERT INTO property.occupant (community_id, unit_id, person_id, relation, full_name, phone_e164, is_primary)
        VALUES (platform.current_community(), CAST(:unit AS uuid), CAST(:person AS uuid), :relation, :name, :phone,
                CAST(:relation AS text) = 'Owner' AND NOT EXISTS (SELECT 1 FROM property.occupant o WHERE o.unit_id = CAST(:unit AS uuid) AND o.is_primary AND o.relation = 'Owner' AND o.to_date IS NULL))""";

    private final NamedParameterJdbcTemplate jdbc; private final com.fasterxml.jackson.databind.ObjectMapper json;
    public JdbcMemberRepository(NamedParameterJdbcTemplate jdbc, com.fasterxml.jackson.databind.ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public Page<MemberView> find(Spec<MemberView> scope, Filter f, PageQuery page) {
        Map<String, Object> p = new HashMap<>(scope.params());
        p.put("q", f.q() == null || f.q().isBlank() ? null : Rows.like(f.q().strip()));
        p.put("status", f.status()); p.put("role", f.roleCode()); p.put("limit", page.limit()); p.put("offset", page.offset());
        long[] total = {0};
        List<MemberView> rows = jdbc.query(listSql(scope.sql()), p, (rs, i) -> {
            total[0] = rs.getLong("total"); return map(rs);
        });
        return new Page<>(rows, total[0], page.limit(), page.offset());
    }
    @Override public Optional<MemberView> findById(MembershipId id, Spec<MemberView> scope) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString());
        return jdbc.query(getSql(scope.sql()), p, (rs, i) -> map(rs)).stream().findFirst();
    }
    @Override public MembershipId insert(PersonId person, String name) { return new MembershipId(jdbc.queryForObject(INSERT, Map.of("person", person.toString(), "name", name), UUID.class)); }
    @Override public boolean replaceRoles(MembershipId id, List<UUID> roleIds, UUID primary, long expectedVersion) {
        if (jdbc.update(BUMP, Map.of("id", id.toString(), "version", expectedVersion)) != 1) return false;
        jdbc.update(CLEAR_ROLES, Map.of("id", id.toString()));
        for (UUID r : roleIds) jdbc.update(ADD_ROLE, Map.of("id", id.toString(), "role", r.toString(), "primary", r.equals(primary)));
        return true;
    }
    @Override public boolean setStatus(MembershipId id, String status, long expectedVersion) {
        return jdbc.update(STATUS, Map.of("id", id.toString(), "status", status, "version", expectedVersion)) == 1;
    }
    @Override public void addOccupant(UnitId unit, PersonId person, String relation, String fullName, String phone) {
        jdbc.update(OCCUPANT, Map.of("unit", unit.toString(), "person", person.toString(), "relation", relation, "name", fullName, "phone", phone));
    }

    private MemberView map(ResultSet rs) throws SQLException {
        List<MemberView.Role> roles = new ArrayList<>();
        try { for (Map<?, ?> r : json.readValue(rs.getString("roles"), Map[].class)) roles.add(new MemberView.Role((String) r.get("code"), (String) r.get("name"), Boolean.TRUE.equals(r.get("primary")))); }
        catch (java.io.IOException e) { throw new SQLException(e); }
        return new MemberView(new MembershipId(Rows.uuid(rs, "id")), new PersonId(Rows.uuid(rs, "person_id")), rs.getString("display_name"), rs.getString("phone_e164"),
            rs.getString("status"), roles, Rows.set(rs, "units", (o) -> new UnitId((UUID) o)), Rows.instant(rs, "created_at"), Rows.instant(rs, "updated_at"), rs.getLong("version"));
    }
}
