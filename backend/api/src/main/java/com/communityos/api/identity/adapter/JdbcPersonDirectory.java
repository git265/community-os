package com.communityos.api.identity.adapter;

import com.communityos.api.identity.application.port.PersonDirectory;
import com.communityos.api.identity.domain.Phone;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.jdbc.Rows;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** People across communities, on the platform connection. */
public final class JdbcPersonDirectory implements PersonDirectory {
    static final String BY_PHONE = "SELECT id, full_name FROM identity.person WHERE phone_e164 = :phone AND status = 'Active'";
    static final String MEMBERSHIPS = """
        SELECT m.community_id, c.name AS community_name, m.id, m.display_name
        FROM identity.membership m JOIN platform.community c ON c.id = m.community_id
        WHERE m.person_id = CAST(:person AS uuid) AND m.status = 'Active' AND c.status = 'Active' ORDER BY c.name""";
    static final String IS_ACTIVE = """
        SELECT EXISTS (SELECT 1 FROM identity.membership m JOIN platform.community c ON c.id = m.community_id JOIN identity.person p ON p.id = m.person_id
                       WHERE m.community_id = CAST(:community AS uuid) AND m.id = CAST(:membership AS uuid) AND m.person_id = CAST(:person AS uuid)
                         AND m.status = 'Active' AND c.status = 'Active' AND p.status = 'Active')""";
    static final String FIND_OR_CREATE = """
        INSERT INTO identity.person (phone_e164, full_name) VALUES (:phone, :name)
        ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164 RETURNING id""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcPersonDirectory(NamedParameterJdbcTemplate platformJdbc) { this.jdbc = platformJdbc; }

    @Override public Optional<PersonRef> findActiveByPhone(Phone phone) {
        return jdbc.query(BY_PHONE, Map.of("phone", phone.e164()), (rs, i) -> new PersonRef(new PersonId(Rows.uuid(rs, "id")), rs.getString("full_name"))).stream().findFirst();
    }
    @Override public List<MembershipRef> activeMemberships(PersonId person) {
        return jdbc.query(MEMBERSHIPS, Map.of("person", person.toString()), (rs, i) -> new MembershipRef(new CommunityId(Rows.uuid(rs, "community_id")),
            rs.getString("community_name"), new MembershipId(Rows.uuid(rs, "id")), rs.getString("display_name")));
    }
    @Override public boolean isActive(PersonId person, CommunityId community, MembershipId membership) {
        return Boolean.TRUE.equals(jdbc.queryForObject(IS_ACTIVE, Map.of("person", person.toString(), "community", community.toString(), "membership", membership.toString()), Boolean.class));
    }
    @Override public PersonId findOrCreate(Phone phone, String fullName) {
        return new PersonId(jdbc.queryForObject(FIND_OR_CREATE, Map.of("phone", phone.e164(), "name", fullName), UUID.class));
    }
}
