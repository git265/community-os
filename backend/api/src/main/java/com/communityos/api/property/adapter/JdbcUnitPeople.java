package com.communityos.api.property.adapter;

import com.communityos.api.property.application.port.UnitPeople;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The people of a unit over time, on the tenant connection (every statement is limited to the community by RLS). */
public final class JdbcUnitPeople implements UnitPeople {
    static final String PEOPLE = """
        SELECT o.id, o.person_id, m.id AS membership_id, o.full_name, o.phone_e164, CAST(o.email AS text) AS email, o.relation, o.is_primary, o.portal_access,
               o.from_date, o.to_date, m.status AS member_status
        FROM property.occupant o LEFT JOIN identity.membership m ON m.community_id = o.community_id AND m.person_id = o.person_id
        WHERE o.unit_id = CAST(:unit AS uuid) AND (CAST(:past AS boolean) OR o.to_date IS NULL)
        ORDER BY (o.to_date IS NULL) DESC, o.to_date DESC NULLS FIRST, (o.relation = 'Owner' AND o.is_primary) DESC,
                 CASE o.relation WHEN 'Owner' THEN 1 WHEN 'Co-owner' THEN 2 WHEN 'Tenant' THEN 3 ELSE 4 END, o.created_at
        LIMIT 500""";
    static final String ADD = """
        INSERT INTO property.occupant (community_id, unit_id, person_id, relation, full_name, phone_e164, email, is_primary, from_date)
        VALUES (platform.current_community(), CAST(:unit AS uuid), CAST(:person AS uuid), :relation, :name, :phone, CAST(CAST(:email AS text) AS citext), :primary, CAST(:from AS date))
        RETURNING id""";
    static final String UPDATE = """
        UPDATE property.occupant SET full_name = :name, email = CAST(CAST(:email AS text) AS citext), relation = :relation, is_primary = :primary
        WHERE id = CAST(:id AS uuid) AND to_date IS NULL""";
    /** The day they left (never before the day they came). */
    static final String END = """
        UPDATE property.occupant SET to_date = greatest(CAST(:on AS date), coalesce(from_date, CAST(:on AS date)))
        WHERE id = ANY (CAST(:ids AS uuid[])) AND to_date IS NULL""";
    static final String MEMBERSHIP = """
        SELECT m.id, m.status, m.version,
               ARRAY(SELECT r.code FROM identity.membership_role mr JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                      WHERE mr.community_id = m.community_id AND mr.membership_id = m.id) AS roles
        FROM identity.membership m WHERE m.person_id = CAST(:person AS uuid)""";
    static final String ADD_MEMBER = """
        INSERT INTO identity.membership (community_id, person_id, display_name, status, joined_on)
        VALUES (platform.current_community(), CAST(:person AS uuid), :name, 'Active', platform.today()) RETURNING id""";
    static final String MEMBER_STATUS = """
        UPDATE identity.membership SET status = :status,
               left_on = CASE WHEN CAST(:status AS text) = 'Inactive' THEN greatest(platform.today(), coalesce(joined_on, platform.today())) END,
               joined_on = CASE WHEN CAST(:status AS text) = 'Active' THEN coalesce(joined_on, platform.today()) ELSE joined_on END
        WHERE id = CAST(:id AS uuid)""";
    static final String GIVE_ROLE = """
        INSERT INTO identity.membership_role (community_id, membership_id, role_id, is_primary)
        SELECT platform.current_community(), CAST(:m AS uuid), r.id, true FROM identity.role r
        WHERE r.code = :code AND NOT EXISTS (SELECT 1 FROM identity.membership_role x WHERE x.membership_id = CAST(:m AS uuid))""";
    static final String OTHER_HOME = """
        SELECT EXISTS (SELECT 1 FROM property.occupant o WHERE o.person_id = CAST(:person AS uuid) AND o.unit_id <> CAST(:unit AS uuid) AND o.to_date IS NULL) AS other""";
    /** A household that leaves takes its gate access with it: staff links end, passes are cancelled, cars are no longer known, the unit's rule is reset. */
    static final String END_GATE = """
        WITH l AS (UPDATE gate.household_link SET status = 'Ended' WHERE unit_id = CAST(:unit AS uuid) AND status = 'Active' RETURNING 1),
        p AS (UPDATE gate.pass SET status = 'Cancelled' WHERE unit_id = CAST(:unit AS uuid) AND status = 'Active' RETURNING 1),
        v AS (UPDATE gate.vehicle SET status = 'Ended' WHERE unit_id = CAST(:unit AS uuid) AND status = 'Active' RETURNING 1),
        r AS (UPDATE gate.unit_rule SET delivery_mode = NULL, companies = '{}', expecting_until = NULL, away_mode = false, fallback = NULL,
                     tell_guest_exit = false, tell_staff = false, tell_delivery = true
              WHERE unit_id = CAST(:unit AS uuid) RETURNING 1)
        SELECT (SELECT count(*) FROM l) AS links, (SELECT count(*) FROM p) AS passes, (SELECT count(*) FROM v) AS vehicles, (SELECT count(*) FROM r) AS rules""";
    static final String LEFTOVERS = """
        SELECT coalesce((SELECT sum(d.amount + d.tax_amount - d.paid_amount - d.credit_applied) FROM billing.due d
                          WHERE d.unit_id = CAST(:unit AS uuid) AND d.status IN ('Unpaid', 'Partly paid')), 0) AS dues,
               (SELECT count(*) FROM billing.due d WHERE d.unit_id = CAST(:unit AS uuid) AND d.status IN ('Unpaid', 'Partly paid')) AS bills,
               (SELECT count(*) FROM amenity.booking b WHERE b.unit_id = CAST(:unit AS uuid) AND b.status IN ('Pending payment', 'Confirmed')
                  AND b.date >= CAST(:today AS date) AND b.booked_by_id = ANY (CAST(:members AS uuid[]))) AS bookings,
               (SELECT count(*) FROM maintenance.ticket t WHERE t.status NOT IN ('Completed', 'Closed', 'Cancelled') AND t.raised_by_id = ANY (CAST(:members AS uuid[]))) AS tickets""";
    static final String OCCUPANCY = """
        UPDATE property.unit SET occupancy = coalesce(CAST(:occ AS text), occupancy), bill_to = coalesce(CAST(:billTo AS text), bill_to) WHERE id = CAST(:unit AS uuid)""";
    static final String RECORD = """
        INSERT INTO property.unit_change (community_id, unit_id, kind, on_date, people_out, people_in, occupancy_before, occupancy_after, dues_outstanding, summary, note)
        VALUES (platform.current_community(), CAST(:unit AS uuid), :kind, CAST(:on AS date), CAST(:out AS jsonb), CAST(:in AS jsonb), :ob, :oa, :dues, CAST(:summary AS jsonb), :note)
        RETURNING id""";
    static final String CHANGES = """
        SELECT c.id, c.short_id, c.unit_id, c.kind, c.on_date, c.people_out::text AS people_out, c.people_in::text AS people_in, c.occupancy_before, c.occupancy_after,
               c.dues_outstanding, c.summary::text AS summary, c.note, m.display_name AS by_name, c.created_at
        FROM property.unit_change c LEFT JOIN identity.membership m ON m.community_id = c.community_id AND m.id = c.created_by
        WHERE c.unit_id = CAST(:unit AS uuid) ORDER BY c.on_date DESC, c.created_at DESC LIMIT 200""";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcUnitPeople(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    @Override public List<Person> people(UUID unit, boolean withPast) {
        return jdbc.query(PEOPLE, Map.of("unit", unit.toString(), "past", withPast), (rs, i) -> new Person(Rows.uuid(rs, "id"), Rows.uuid(rs, "person_id"), Rows.uuid(rs, "membership_id"),
            rs.getString("full_name"), rs.getString("phone_e164"), rs.getString("email"), rs.getString("relation"), rs.getBoolean("is_primary"), rs.getBoolean("portal_access"),
            Rows.date(rs, "from_date"), Rows.date(rs, "to_date"), rs.getString("member_status")));
    }
    @Override public UUID addOccupant(UUID unit, UUID person, String relation, String name, String phone, String email, boolean primary, LocalDate from) {
        Map<String, Object> p = new HashMap<>();
        p.put("unit", unit.toString()); p.put("person", person == null ? null : person.toString()); p.put("relation", relation); p.put("name", name); p.put("phone", phone);
        p.put("email", email); p.put("primary", primary); p.put("from", from == null ? null : from.toString());
        return jdbc.queryForObject(ADD, p, UUID.class);
    }
    @Override public void updateOccupant(UUID occupantId, String name, String email, String relation, boolean primary) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", occupantId.toString()); p.put("name", name); p.put("email", email); p.put("relation", relation); p.put("primary", primary);
        jdbc.update(UPDATE, p);
    }
    @Override public int endOccupants(List<UUID> ids, LocalDate on) {
        if (ids.isEmpty()) return 0;
        return jdbc.update(END, Map.of("ids", Rows.pgArray(ids), "on", on.toString()));
    }
    @Override public Optional<Membership> membership(UUID person) {
        return jdbc.query(MEMBERSHIP, Map.of("person", person.toString()), (rs, i) -> new Membership(Rows.uuid(rs, "id"), rs.getString("status"), rs.getLong("version"),
            new LinkedHashSet<>(Rows.list(rs, "roles", String::valueOf)))).stream().findFirst();
    }
    @Override public UUID addMembership(UUID person, String displayName) {
        return jdbc.queryForObject(ADD_MEMBER, Map.of("person", person.toString(), "name", displayName), UUID.class);
    }
    @Override public void setMemberStatus(UUID membership, String status) { jdbc.update(MEMBER_STATUS, Map.of("id", membership.toString(), "status", status)); }
    @Override public void giveRoleIfNone(UUID membership, String roleCode) { jdbc.update(GIVE_ROLE, Map.of("m", membership.toString(), "code", roleCode)); }
    @Override public boolean hasOtherHome(UUID person, UUID exceptUnit) {
        return Boolean.TRUE.equals(jdbc.queryForObject(OTHER_HOME, Map.of("person", person.toString(), "unit", exceptUnit.toString()), Boolean.class));
    }
    @Override public GateEnded endGateAccess(UUID unit) {
        return jdbc.query(END_GATE, Map.of("unit", unit.toString()), (rs, i) -> new GateEnded(rs.getInt("links"), rs.getInt("passes"), rs.getInt("vehicles"), rs.getInt("rules") > 0))
            .stream().findFirst().orElse(new GateEnded(0, 0, 0, false));
    }
    @Override public Leftovers leftovers(UUID unit, List<UUID> leaving, LocalDate today) {
        return jdbc.query(LEFTOVERS, Map.of("unit", unit.toString(), "members", Rows.pgArray(leaving), "today", today.toString()), (rs, i) -> new Leftovers(rs.getBigDecimal("dues"),
            rs.getInt("bills"), rs.getInt("bookings"), rs.getInt("tickets"))).stream().findFirst().orElse(new Leftovers(BigDecimal.ZERO, 0, 0, 0));
    }
    @Override public void setOccupancy(UUID unit, String occupancy, String billTo) {
        Map<String, Object> p = new HashMap<>(); p.put("unit", unit.toString()); p.put("occ", occupancy); p.put("billTo", billTo);
        jdbc.update(OCCUPANCY, p);
    }
    @Override public UUID recordChange(UUID unit, String kind, LocalDate on, List<Map<String, Object>> out, List<Map<String, Object>> in, String occupancyBefore, String occupancyAfter,
                                       BigDecimal dues, Map<String, Object> summary, String note) {
        Map<String, Object> p = new HashMap<>();
        p.put("unit", unit.toString()); p.put("kind", kind); p.put("on", on.toString()); p.put("ob", occupancyBefore); p.put("oa", occupancyAfter);
        p.put("dues", dues == null ? BigDecimal.ZERO : dues); p.put("note", note);
        try { p.put("out", json.writeValueAsString(out)); p.put("in", json.writeValueAsString(in)); p.put("summary", json.writeValueAsString(summary)); }
        catch (Exception e) { throw new IllegalStateException(e); }
        return jdbc.queryForObject(RECORD, p, UUID.class);
    }
    @Override public List<Change> changes(UUID unit) {
        return jdbc.query(CHANGES, Map.of("unit", unit.toString()), (rs, i) -> {
            try {
                return new Change(Rows.uuid(rs, "id"), rs.getString("short_id"), Rows.uuid(rs, "unit_id"), rs.getString("kind"), Rows.date(rs, "on_date"),
                    json.readValue(rs.getString("people_out"), new TypeReference<List<Map<String, Object>>>() {}), json.readValue(rs.getString("people_in"), new TypeReference<List<Map<String, Object>>>() {}),
                    rs.getString("occupancy_before"), rs.getString("occupancy_after"), rs.getBigDecimal("dues_outstanding"),
                    json.readValue(rs.getString("summary"), new TypeReference<Map<String, Object>>() {}), rs.getString("note"), rs.getString("by_name"), Rows.instant(rs, "created_at"));
            } catch (java.io.IOException e) { throw new java.sql.SQLException(e); }
        });
    }
}
