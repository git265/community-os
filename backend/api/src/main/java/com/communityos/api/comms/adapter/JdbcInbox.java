package com.communityos.api.comms.adapter;

import com.communityos.api.comms.application.port.Facts;
import com.communityos.api.comms.application.port.Inbox;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.shared.jdbc.Rows;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * The inbox on the tenant connection. One statement fans a message out: the people it reaches (members by id, people with portal access to
 * the units, holders of the roles ("@ec": every committee role) + the roles the community added for this event), minus the person doing it; one inbox row each; then a
 * queued channel message for each extra channel the person chose and the community offers for the event (Skipped when there is no address).
 * Also the Facts port: a notification's few words about the ticket, booking or visit it is about.
 */
public final class JdbcInbox implements Inbox, Facts {
    static final String DELIVER = """
        WITH s AS (SELECT x.events FROM comms.notification_setting x LIMIT 1),
        also AS (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.events -> CAST(:event AS text) -> 'alsoRoles') = 'array'
                                                       THEN s.events -> CAST(:event AS text) -> 'alsoRoles' ELSE '[]'::jsonb END) AS code FROM s),
        who AS (
          SELECT m.id, m.person_id, m.display_name FROM identity.membership m
          WHERE m.status = 'Active' AND m.id IS DISTINCT FROM platform.current_actor()
            AND (m.id = ANY (CAST(:members AS uuid[]))
              OR EXISTS (SELECT 1 FROM property.occupant o WHERE o.community_id = m.community_id AND o.person_id = m.person_id AND o.portal_access
                           AND (o.to_date IS NULL OR o.to_date > current_date) AND o.unit_id = ANY (CAST(:units AS uuid[]))
                           AND (cardinality(CAST(:relations AS text[])) = 0 OR o.relation = ANY (CAST(:relations AS text[]))))
              OR EXISTS (SELECT 1 FROM identity.membership_role mr JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                          WHERE mr.community_id = m.community_id AND mr.membership_id = m.id AND (r.code = ANY (CAST(:roles AS text[])) OR r.code IN (SELECT code FROM also)
                            OR ('@ec' = ANY (CAST(:roles AS text[])) AND EXISTS (SELECT 1 FROM identity.role_group g
                                 WHERE g.community_id = r.community_id AND g.id = r.group_id AND g.category = 'EC')))))),
        sent AS (
          INSERT INTO comms.notification (community_id, id, created_at, to_membership_id, event, kind, title, body, link, sender_id, ref_id)
          SELECT platform.current_community(), gen_random_uuid(), now(), who.id, CAST(:event AS text), CAST(:kind AS text), CAST(:title AS text), CAST(:body AS text),
                 CAST(:link AS text), platform.current_actor(), CAST(:ref AS uuid)
          FROM who
          RETURNING to_membership_id, id),
        pushed AS (
          INSERT INTO comms.push_queue (community_id, subscription_id, notification_id, title, body, link)
          SELECT platform.current_community(), ps.id, sent.id, CAST(:title AS text), left(CAST(:body AS text), 4000), CAST(:link AS text)
          FROM sent JOIN comms.push_subscription ps ON ps.membership_id = sent.to_membership_id
          RETURNING 1),
        queued AS (
          INSERT INTO comms.outbox_message (community_id, id, created_at, event, channel, to_value, status, membership_id, subject, body, error)
          SELECT platform.current_community(), gen_random_uuid(), now(), CAST(:event AS text), ch.channel, ch.addr, CASE WHEN ch.addr IS NULL THEN 'Skipped' ELSE 'Queued' END,
                 who.id, CAST(:title AS text), 'Hello ' || who.display_name || ', ' || CAST(:body AS text),
                 CASE WHEN ch.addr IS NULL THEN 'no ' || CASE ch.channel WHEN 'Email' THEN 'e-mail address' ELSE 'phone number' END END
          FROM sent JOIN who ON who.id = sent.to_membership_id
          JOIN comms.notification_pref np ON np.membership_id = who.id
          JOIN identity.person p ON p.id = who.person_id
          LEFT JOIN s ON TRUE
          CROSS JOIN LATERAL (VALUES ('WhatsApp', np.whatsapp, p.phone_e164), ('SMS', np.sms, p.phone_e164), ('Email', np.email, CAST(p.email AS text))) AS ch(channel, wanted, addr)
          WHERE ch.wanted AND coalesce(CAST(s.events -> CAST(:event AS text) ->> lower(ch.channel) AS boolean), TRUE)
          RETURNING 1)
        SELECT (SELECT count(*) FROM sent) AS sent, (SELECT count(*) FROM queued) AS queued, (SELECT count(*) FROM pushed) AS pushed""";
    static final String MINE = """
        SELECT n.id, n.created_at, n.event, n.kind, n.title, n.body, n.link, n.ref_id, s.display_name AS sender, n.read_at
        FROM comms.notification n LEFT JOIN identity.membership s ON s.community_id = n.community_id AND s.id = n.sender_id
        WHERE n.to_membership_id = CAST(:me AS uuid) AND (NOT CAST(:unread AS boolean) OR n.read_at IS NULL)
        ORDER BY n.created_at DESC LIMIT :limit""";
    static final String UNREAD = "SELECT count(*) AS n FROM comms.notification n WHERE n.to_membership_id = CAST(:me AS uuid) AND n.read_at IS NULL";
    static final String MARK_READ = """
        UPDATE comms.notification SET read_at = now()
        WHERE to_membership_id = CAST(:me AS uuid) AND read_at IS NULL AND (CAST(:id AS uuid) IS NULL OR id = CAST(:id AS uuid))""";

    // ---- facts -----------------------------------------------------------------------------------------------------------------------------------
    static final String TICKET = """
        SELECT t.short_id AS number, t.title, t.unit_id, u.unit_no, t.raised_by_id AS owner, t.assignee_id AS other, NULL AS extra
        FROM maintenance.ticket t LEFT JOIN property.unit u ON u.community_id = t.community_id AND u.id = t.unit_id WHERE t.id = CAST(:id AS uuid)""";
    static final String BOOKING = """
        SELECT b.short_id AS number, a.name AS title, b.unit_id, u.unit_no, b.booked_by_id AS owner, NULL AS other, b.slot AS extra
        FROM amenity.booking b JOIN amenity.amenity_type a ON a.community_id = b.community_id AND a.id = b.amenity_type_id
        LEFT JOIN property.unit u ON u.community_id = b.community_id AND u.id = b.unit_id WHERE b.id = CAST(:id AS uuid)""";
    static final String GATE_APPROVAL = """
        SELECT x.short_id AS number, x.name AS title, x.unit_id, u.unit_no, NULL AS owner, NULL AS other, x.gate AS extra
        FROM gate.approval x LEFT JOIN property.unit u ON u.community_id = x.community_id AND u.id = x.unit_id WHERE x.id = CAST(:id AS uuid)""";
    static final String GATE_VISIT = """
        SELECT x.short_id AS number, x.name AS title, x.unit_id, u.unit_no, NULL AS owner, NULL AS other, coalesce(x.company, x.gate) AS extra
        FROM gate.visit x LEFT JOIN property.unit u ON u.community_id = x.community_id AND u.id = x.unit_id WHERE x.id = CAST(:id AS uuid)""";
    static final String GATE_FLAG = """
        SELECT x.short_id AS number, x.person_name AS title, x.unit_id, u.unit_no, NULL AS owner, NULL AS other, x.detail AS extra
        FROM gate.flag x LEFT JOIN property.unit u ON u.community_id = x.community_id AND u.id = x.unit_id WHERE x.id = CAST(:id AS uuid)""";

    /** Which of the switchable gate events a unit hears: the community's event list (on unless switched off) and the unit's own switches
     *  (guest exit and maid / driver in-out off, deliveries on, unless the unit set them). */
    static final String GATE_RULE = """
        WITH s AS (SELECT coalesce((SELECT x.events FROM gate.setting x ORDER BY x.created_at LIMIT 1), '{}'::jsonb) AS ev),
        r AS (SELECT u.tell_guest_exit, u.tell_staff, u.tell_delivery FROM gate.unit_rule u WHERE u.unit_id = CAST(:id AS uuid))
        SELECT NULL AS number, NULL AS title, CAST(:id AS uuid) AS unit_id, NULL AS unit_no, NULL AS owner, NULL AS other,
               concat_ws(',',
                 CASE WHEN coalesce(s.ev -> 'guest_arrived' ->> 'on', 'true') <> 'false' THEN 'guest_arrived' END,
                 CASE WHEN coalesce(s.ev -> 'guest_exit' ->> 'on', 'true') <> 'false' AND coalesce((SELECT r.tell_guest_exit FROM r), false) THEN 'guest_exit' END,
                 CASE WHEN coalesce(s.ev -> 'delivery' ->> 'on', 'true') <> 'false' AND coalesce((SELECT r.tell_delivery FROM r), true) THEN 'delivery' END,
                 CASE WHEN coalesce(s.ev -> 'staff_inout' ->> 'on', 'true') <> 'false' AND coalesce((SELECT r.tell_staff FROM r), false) THEN 'staff_inout' END,
                 CASE WHEN coalesce(s.ev -> 'crew_inout' ->> 'on', 'true') <> 'false' THEN 'crew_inout' END) AS extra
        FROM s""";

    /** Who a bill is addressed to (extra = Owner / Tenant): the bill's own (id = a bill), else its unit's (id = a unit). */
    static final String BILL_TO = """
        SELECT NULL AS number, NULL AS title, NULL AS unit_id, NULL AS unit_no, NULL AS owner, NULL AS other,
               coalesce((SELECT d.bill_to FROM billing.due d WHERE d.id = CAST(:id AS uuid)), (SELECT u.bill_to FROM property.unit u WHERE u.id = CAST(:id AS uuid)), 'Owner') AS extra""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcInbox(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public int deliver(Comms.Message m) {
        Map<String, Object> p = new HashMap<>();
        p.put("event", m.event()); p.put("kind", m.kind()); p.put("title", m.title()); p.put("body", m.body()); p.put("link", m.link());
        p.put("ref", m.refId() == null ? null : m.refId().toString());
        p.put("members", array(m.to().members())); p.put("units", array(m.to().units())); p.put("roles", array(m.to().roles())); p.put("relations", array(m.to().relations()));
        return jdbc.query(DELIVER, p, (rs, i) -> rs.getInt("sent")).stream().findFirst().orElse(0);
    }
    @Override public List<Comms.Note> mine(UUID membership, boolean unreadOnly, int limit) {
        return jdbc.query(MINE, Map.of("me", membership.toString(), "unread", unreadOnly, "limit", Math.max(1, Math.min(limit, 500))), (rs, i) -> new Comms.Note(Rows.uuid(rs, "id"),
            Rows.instant(rs, "created_at"), rs.getString("event"), rs.getString("kind"), rs.getString("title"), rs.getString("body"), rs.getString("link"), Rows.uuid(rs, "ref_id"),
            rs.getString("sender"), Rows.instant(rs, "read_at")));
    }
    @Override public int unread(UUID membership) {
        return jdbc.query(UNREAD, Map.of("me", membership.toString()), (rs, i) -> rs.getInt("n")).stream().findFirst().orElse(0);
    }
    @Override public int markRead(UUID membership, UUID id) {
        Map<String, Object> p = new HashMap<>(); p.put("me", membership.toString()); p.put("id", id == null ? null : id.toString());
        return jdbc.update(MARK_READ, p);
    }

    @Override public Optional<Fact> of(Kind kind, UUID id) {
        String sql = switch (kind) { case TICKET -> TICKET; case BOOKING -> BOOKING; case GATE_APPROVAL -> GATE_APPROVAL; case GATE_VISIT -> GATE_VISIT; case GATE_FLAG -> GATE_FLAG; case GATE_RULE -> GATE_RULE; case BILL_TO -> BILL_TO; };
        return jdbc.query(sql, Map.of("id", id.toString()), (rs, i) -> new Fact(rs.getString("number"), rs.getString("title"), Rows.uuid(rs, "unit_id"), rs.getString("unit_no"),
            Rows.uuid(rs, "owner"), Rows.uuid(rs, "other"), rs.getString("extra"))).stream().findFirst();
    }

    static String array(Collection<?> xs) { return com.communityos.api.shared.jdbc.Rows.pgArray(xs); }
}
