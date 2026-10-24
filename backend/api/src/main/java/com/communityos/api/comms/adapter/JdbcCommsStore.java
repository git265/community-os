package com.communityos.api.comms.adapter;

import com.communityos.api.comms.application.port.CommsStore;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.jdbc.Rows;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Notices (with receipts and polls) and the forum on the tenant connection. Counts are computed from the receipts, never stored by a client. */
public final class JdbcCommsStore implements CommsStore {
    // ---- notices -------------------------------------------------------------------------------------------------------------------------------
    static final String BROADCAST_COLUMNS = """
        SELECT b.id, b.short_id, b.type, b.audience, b.subject, b.message, b.audience_units, b.audience_blocks, b.event_date, b.start_time, b.end_time, b.affects,
               b.poll_options, b.poll_multiple, b.poll_closes_on, b.requires_signature, b.reminder_frequency, b.status, b.sent_at, b.sent_by_id, s.display_name AS sent_by,
               b.scheduled_for, b.created_at, b.version, me.viewed_at AS my_viewed_at, me.signed_at AS my_signed_at,
               (SELECT count(*) FROM comms.broadcast_receipt x WHERE x.community_id = b.community_id AND x.broadcast_id = b.id) AS recipients,
               (SELECT count(*) FROM comms.broadcast_receipt x WHERE x.community_id = b.community_id AND x.broadcast_id = b.id AND x.viewed_at IS NOT NULL) AS viewed,
               (SELECT count(*) FROM comms.broadcast_receipt x WHERE x.community_id = b.community_id AND x.broadcast_id = b.id AND x.signed_at IS NOT NULL) AS signed,
               ARRAY(SELECT sm.display_name FROM comms.broadcast_receipt x JOIN identity.membership sm ON sm.community_id = x.community_id AND sm.id = x.membership_id
                      WHERE x.community_id = b.community_id AND x.broadcast_id = b.id AND x.signed_at IS NOT NULL ORDER BY x.signed_at) AS signed_by
        FROM comms.broadcast b
        LEFT JOIN identity.membership s ON s.community_id = b.community_id AND s.id = b.sent_by_id
        LEFT JOIN comms.broadcast_receipt me ON me.community_id = b.community_id AND me.broadcast_id = b.id AND me.membership_id = CAST(:reader AS uuid)""";
    public static String broadcastsSql(String scope) {
        return BROADCAST_COLUMNS + "\nWHERE (" + scope + ") AND (CAST(:status AS text) IS NULL OR b.status = :status)\nORDER BY coalesce(b.sent_at, b.scheduled_for, b.created_at) DESC LIMIT 500";
    }
    public static String broadcastSql(String scope) { return BROADCAST_COLUMNS + "\nWHERE b.id = CAST(:id AS uuid) AND (" + scope + ")"; }
    static final String BROADCAST_INSERT = """
        INSERT INTO comms.broadcast (community_id, id, type, audience, subject, message, audience_units, audience_blocks, event_date, start_time, end_time, affects, poll_options,
                                     poll_multiple, poll_closes_on, requires_signature, reminder_frequency, status, scheduled_for)
        VALUES (platform.current_community(), CAST(:id AS uuid), :type, :audience, :subject, :message, CAST(:units AS text[]), CAST(:blocks AS text[]), CAST(:eventDate AS date),
                :startTime, :endTime, :affects, CAST(:pollOptions AS text[]), :pollMultiple, CAST(:pollClosesOn AS date), :requiresSignature, :reminder, :status,
                CAST(:scheduledFor AS timestamptz))
        RETURNING short_id, version, created_at""";
    static final String BROADCAST_UPDATE = """
        UPDATE comms.broadcast SET type = :type, audience = :audience, subject = :subject, message = :message, audience_units = CAST(:units AS text[]),
               audience_blocks = CAST(:blocks AS text[]), event_date = CAST(:eventDate AS date), start_time = :startTime, end_time = :endTime, affects = :affects,
               poll_options = CAST(:pollOptions AS text[]), poll_multiple = :pollMultiple, poll_closes_on = CAST(:pollClosesOn AS date), requires_signature = :requiresSignature,
               reminder_frequency = :reminder, status = :status, scheduled_for = CAST(:scheduledFor AS timestamptz), sent_at = CAST(:sentAt AS timestamptz),
               sent_by_id = CAST(:sentBy AS uuid), recipients = :recipients, push_delivered = :recipients
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String BROADCAST_DELETE = "DELETE FROM comms.broadcast WHERE id = CAST(:id AS uuid) AND version = :version";
    /** The people an audience reaches: active members with portal access to a matching unit, or holding a committee / staff role. */
    static final String AUDIENCE = """
        SELECT m.id FROM identity.membership m
        WHERE m.status = 'Active' AND (
          (CAST(:kind AS text) IN ('EC members', 'Staff') AND EXISTS (
              SELECT 1 FROM identity.membership_role mr JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
              JOIN identity.role_group g ON g.community_id = r.community_id AND g.id = r.group_id
              WHERE mr.community_id = m.community_id AND mr.membership_id = m.id AND g.category = CASE CAST(:kind AS text) WHEN 'EC members' THEN 'EC' ELSE 'Staff' END))
          OR EXISTS (
              SELECT 1 FROM property.occupant o JOIN property.unit u ON u.community_id = o.community_id AND u.id = o.unit_id
              WHERE o.community_id = m.community_id AND o.person_id = m.person_id AND o.portal_access AND (o.to_date IS NULL OR o.to_date > current_date)
                AND CASE CAST(:kind AS text)
                      WHEN 'All residents' THEN TRUE
                      WHEN 'Owners' THEN o.relation = 'Owner'
                      WHEN 'All villas' THEN u.unit_type = 'Villa'
                      WHEN 'All apartments' THEN u.unit_type = 'Apartment'
                      WHEN 'Selected villas' THEN u.id = ANY (CAST(:units AS uuid[]))
                      WHEN 'Selected apartments' THEN u.id = ANY (CAST(:units AS uuid[]))
                      WHEN 'Selected blocks' THEN u.block_id = ANY (CAST(:blocks AS uuid[]))
                      ELSE FALSE END))""";
    static final String DELIVER = "INSERT INTO comms.broadcast_receipt (community_id, broadcast_id, membership_id)\nSELECT platform.current_community(), CAST(:id AS uuid), a.id FROM ("
        + AUDIENCE + ") a\nON CONFLICT DO NOTHING";
    static final String REACH = "SELECT count(*) AS n FROM (" + AUDIENCE + ") a";
    static final String RECIPIENTS = "SELECT x.membership_id FROM comms.broadcast_receipt x WHERE x.broadcast_id = CAST(:id AS uuid)";
    static final String VIEWED = "UPDATE comms.broadcast_receipt SET viewed_at = coalesce(viewed_at, CAST(:at AS timestamptz)) WHERE broadcast_id = CAST(:id AS uuid) AND membership_id = CAST(:me AS uuid)";
    static final String SIGNED = """
        UPDATE comms.broadcast_receipt SET signed_at = coalesce(signed_at, CAST(:at AS timestamptz)), viewed_at = coalesce(viewed_at, CAST(:at AS timestamptz))
        WHERE broadcast_id = CAST(:id AS uuid) AND membership_id = CAST(:me AS uuid)""";
    static final String DUE = "SELECT b.id FROM comms.broadcast b WHERE b.status = 'Scheduled' AND b.scheduled_for <= CAST(:now AS timestamptz) ORDER BY b.scheduled_for LIMIT 100";

    // ---- polls -----------------------------------------------------------------------------------------------------------------------------------
    static final String VOTE_COLUMNS = """
        SELECT v.id, v.voter_id, m.display_name AS voter_name, v.unit_id, u.unit_no, v.choices, v.version
        FROM comms.poll_vote v LEFT JOIN identity.membership m ON m.community_id = v.community_id AND m.id = v.voter_id
        LEFT JOIN property.unit u ON u.community_id = v.community_id AND u.id = v.unit_id""";
    static final String VOTE_OF = VOTE_COLUMNS + """

        WHERE (CAST(:b AS uuid) IS NOT NULL AND v.broadcast_id = CAST(:b AS uuid)
               AND CASE WHEN CAST(:unit AS uuid) IS NULL THEN v.unit_id IS NULL AND v.voter_id = CAST(:voter AS uuid) ELSE v.unit_id = CAST(:unit AS uuid) END)
           OR (CAST(:t AS uuid) IS NOT NULL AND v.topic_id = CAST(:t AS uuid) AND v.voter_id = CAST(:voter AS uuid))""";
    static final String VOTES = VOTE_COLUMNS + "\nWHERE (CAST(:b AS uuid) IS NOT NULL AND v.broadcast_id = CAST(:b AS uuid)) OR (CAST(:t AS uuid) IS NOT NULL AND v.topic_id = CAST(:t AS uuid))";
    static final String VOTE_INSERT = """
        INSERT INTO comms.poll_vote (community_id, broadcast_id, topic_id, voter_id, unit_id, choices)
        VALUES (platform.current_community(), CAST(:b AS uuid), CAST(:t AS uuid), CAST(:voter AS uuid), CAST(:unit AS uuid), CAST(:choices AS text[]))""";
    static final String VOTE_UPDATE = "UPDATE comms.poll_vote SET voter_id = CAST(:voter AS uuid), choices = CAST(:choices AS text[]) WHERE id = CAST(:id AS uuid) AND version = :version";

    // ---- forum -----------------------------------------------------------------------------------------------------------------------------------
    static final String TOPIC_COLUMNS = """
        SELECT t.id, t.short_id, t.title, t.category, t.kind, t.poll_options, t.pinned, t.status, t.replies, t.author_id, m.display_name AS author, t.last_post_at, t.created_at, t.version
        FROM comms.forum_topic t LEFT JOIN identity.membership m ON m.community_id = t.community_id AND m.id = t.author_id""";
    static final String TOPICS = TOPIC_COLUMNS + "\nWHERE (CAST(:category AS text) IS NULL OR lower(t.category) = lower(:category))\nORDER BY t.pinned DESC, coalesce(t.last_post_at, t.created_at) DESC LIMIT 500";
    static final String TOPIC = TOPIC_COLUMNS + "\nWHERE t.id = CAST(:id AS uuid)";
    static final String TOPIC_INSERT = """
        INSERT INTO comms.forum_topic (community_id, id, title, category, kind, poll_options, pinned, status, replies, author_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), :title, :category, :kind, CAST(:pollOptions AS text[]), FALSE, 'Open', 0, platform.current_actor())
        RETURNING short_id, version, created_at""";
    static final String TOPIC_UPDATE = "UPDATE comms.forum_topic SET title = :title, category = :category, pinned = :pinned, status = :status WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version";
    static final String TOPIC_DELETE = "DELETE FROM comms.forum_topic WHERE id = CAST(:id AS uuid) AND version = :version";
    static final String RECOUNT = """
        UPDATE comms.forum_topic t SET replies = (SELECT count(*) FROM comms.forum_post p WHERE p.community_id = t.community_id AND p.topic_id = t.id AND NOT p.hidden),
               last_post_at = (SELECT max(p.created_at) FROM comms.forum_post p WHERE p.community_id = t.community_id AND p.topic_id = t.id AND NOT p.hidden)
        WHERE t.id = CAST(:id AS uuid)""";
    static final String POST_COLUMNS = """
        SELECT p.id, p.short_id, p.topic_id, p.parent_id, p.author_id, m.display_name AS author, r.code AS author_role, p.body, p.reactions, p.hidden, p.hidden_reason, p.edited_at,
               p.created_at, p.version
        FROM comms.forum_post p LEFT JOIN identity.membership m ON m.community_id = p.community_id AND m.id = p.author_id
        LEFT JOIN identity.role r ON r.community_id = p.community_id AND r.id = p.author_role_id""";
    static final String POSTS = POST_COLUMNS + "\nWHERE p.topic_id = CAST(:topic AS uuid) ORDER BY p.created_at LIMIT 2000";
    static final String POST = POST_COLUMNS + "\nWHERE p.id = CAST(:id AS uuid)";
    static final String ALL_POSTS = POST_COLUMNS + "\nORDER BY p.topic_id, p.created_at LIMIT 5000";
    static final String POST_INSERT = """
        INSERT INTO comms.forum_post (community_id, id, topic_id, parent_id, author_id, author_role_id, body, reactions)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:topic AS uuid), CAST(:parent AS uuid), platform.current_actor(),
                (SELECT mr.role_id FROM identity.membership_role mr WHERE mr.membership_id = platform.current_actor() ORDER BY mr.is_primary DESC LIMIT 1), :body, 0)
        RETURNING short_id, version, created_at""";
    static final String POST_UPDATE = """
        UPDATE comms.forum_post SET body = :body, hidden = :hidden, hidden_reason = :hiddenReason, hidden_by_id = CASE WHEN :hidden THEN platform.current_actor() END,
               edited_at = CAST(:editedAt AS timestamptz)
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String POST_DELETE = "DELETE FROM comms.forum_post WHERE id = CAST(:id AS uuid) AND version = :version";
    static final String REACT = "UPDATE comms.forum_post SET reactions = coalesce(reactions, 0) + 1 WHERE id = CAST(:id AS uuid) AND NOT hidden";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcCommsStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    // ---- notices -------------------------------------------------------------------------------------------------------------------------------
    @Override public List<Comms.Broadcast> broadcasts(Spec<Comms.Broadcast> scope, UUID reader, String status) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("reader", str(reader)); p.put("status", status);
        return jdbc.query(broadcastsSql(scope.sql()), p, (rs, i) -> broadcast(rs));
    }
    @Override public Optional<Comms.Broadcast> broadcast(UUID id, Spec<Comms.Broadcast> scope, UUID reader) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("reader", str(reader)); p.put("id", id.toString());
        return jdbc.query(broadcastSql(scope.sql()), p, (rs, i) -> broadcast(rs)).stream().findFirst();
    }
    @Override public void insert(Comms.Broadcast b) {
        if (b.id == null) b.id = UUID.randomUUID();
        jdbc.query(BROADCAST_INSERT, params(b), (rs, i) -> { b.shortId = rs.getString("short_id"); b.version = rs.getLong("version"); b.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Comms.Broadcast b) {
        List<Long> v = jdbc.query(BROADCAST_UPDATE, params(b), (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        b.version = v.get(0); return true;
    }
    @Override public boolean delete(UUID id, long version) { return jdbc.update(BROADCAST_DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    @Override public int deliver(UUID broadcastId, Comms.Audience a) { Map<String, Object> p = audience(a); p.put("id", broadcastId.toString()); return jdbc.update(DELIVER, p); }
    @Override public int reach(Comms.Audience a) { return jdbc.query(REACH, audience(a), (rs, i) -> rs.getInt("n")).stream().findFirst().orElse(0); }
    @Override public List<UUID> recipients(UUID broadcastId) { return jdbc.query(RECIPIENTS, Map.of("id", broadcastId.toString()), (rs, i) -> Rows.uuid(rs, "membership_id")); }
    @Override public boolean viewed(UUID broadcastId, UUID member, Instant at) { return jdbc.update(VIEWED, Map.of("id", broadcastId.toString(), "me", member.toString(), "at", at.toString())) == 1; }
    @Override public boolean signed(UUID broadcastId, UUID member, Instant at) { return jdbc.update(SIGNED, Map.of("id", broadcastId.toString(), "me", member.toString(), "at", at.toString())) == 1; }
    @Override public List<UUID> due(Instant now) { return jdbc.query(DUE, Map.of("now", now.toString()), (rs, i) -> Rows.uuid(rs, "id")); }

    // ---- polls -----------------------------------------------------------------------------------------------------------------------------------
    @Override public Optional<Vote> voteOf(UUID broadcastId, UUID topicId, UUID voter, UUID unit) {
        Map<String, Object> p = new HashMap<>(); p.put("b", str(broadcastId)); p.put("t", str(topicId)); p.put("voter", voter.toString()); p.put("unit", str(unit));
        return jdbc.query(VOTE_OF, p, (rs, i) -> vote(rs)).stream().findFirst();
    }
    @Override public void vote(UUID broadcastId, UUID topicId, UUID voter, UUID unit, List<String> choices, Vote existing) {
        Map<String, Object> p = new HashMap<>(); p.put("b", str(broadcastId)); p.put("t", str(topicId)); p.put("voter", voter.toString()); p.put("unit", str(unit)); p.put("choices", array(choices));
        if (existing == null) { jdbc.update(VOTE_INSERT, p); return; }
        p.put("id", existing.id().toString()); p.put("version", existing.version());
        if (jdbc.update(VOTE_UPDATE, p) != 1) throw new com.communityos.api.shared.domain.DomainException.Conflict("Vote");
    }
    @Override public List<Vote> votes(UUID broadcastId, UUID topicId) {
        Map<String, Object> p = new HashMap<>(); p.put("b", str(broadcastId)); p.put("t", str(topicId));
        return jdbc.query(VOTES, p, (rs, i) -> vote(rs));
    }

    // ---- forum -----------------------------------------------------------------------------------------------------------------------------------
    @Override public List<Comms.Topic> topics(String category) { Map<String, Object> p = new HashMap<>(); p.put("category", category); return jdbc.query(TOPICS, p, (rs, i) -> topic(rs)); }
    @Override public Optional<Comms.Topic> topic(UUID id) { return jdbc.query(TOPIC, Map.of("id", id.toString()), (rs, i) -> topic(rs)).stream().findFirst(); }
    @Override public void insert(Comms.Topic t) {
        if (t.id == null) t.id = UUID.randomUUID();
        Map<String, Object> p = Map.of("id", t.id.toString(), "title", t.title, "category", t.category, "kind", t.kind, "pollOptions", array(t.pollOptions));
        jdbc.query(TOPIC_INSERT, p, (rs, i) -> { t.shortId = rs.getString("short_id"); t.version = rs.getLong("version"); t.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Comms.Topic t) {
        List<Long> v = jdbc.query(TOPIC_UPDATE, Map.of("id", t.id.toString(), "title", t.title, "category", t.category, "pinned", t.pinned, "status", t.status, "version", t.version),
            (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        t.version = v.get(0); return true;
    }
    @Override public boolean deleteTopic(UUID id, long version) { return jdbc.update(TOPIC_DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    @Override public List<Comms.Post> posts(UUID topicId) { return jdbc.query(POSTS, Map.of("topic", topicId.toString()), (rs, i) -> post(rs)); }
    @Override public List<Comms.Post> allPosts() { return jdbc.query(ALL_POSTS, Map.of(), (rs, i) -> post(rs)); }
    @Override public Optional<Comms.Post> post(UUID id) { return jdbc.query(POST, Map.of("id", id.toString()), (rs, i) -> post(rs)).stream().findFirst(); }
    @Override public void insert(Comms.Post x) {
        if (x.id == null) x.id = UUID.randomUUID();
        Map<String, Object> p = new HashMap<>(); p.put("id", x.id.toString()); p.put("topic", x.topicId.toString()); p.put("parent", str(x.parentId)); p.put("body", x.body);
        jdbc.query(POST_INSERT, p, (rs, i) -> { x.shortId = rs.getString("short_id"); x.version = rs.getLong("version"); x.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Comms.Post x) {
        Map<String, Object> p = new HashMap<>(); p.put("id", x.id.toString()); p.put("body", x.body); p.put("hidden", x.hidden); p.put("hiddenReason", x.hiddenReason);
        p.put("editedAt", x.editedAt == null ? null : x.editedAt.toString()); p.put("version", x.version);
        List<Long> v = jdbc.query(POST_UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        x.version = v.get(0); return true;
    }
    @Override public boolean deletePost(UUID id, long version) { return jdbc.update(POST_DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    @Override public void recount(UUID topicId) { jdbc.update(RECOUNT, Map.of("id", topicId.toString())); }
    @Override public boolean react(UUID postId) { return jdbc.update(REACT, Map.of("id", postId.toString())) == 1; }

    // ---- rows --------------------------------------------------------------------------------------------------------------------------------------
    static Comms.Broadcast broadcast(ResultSet rs) throws SQLException {
        Comms.Broadcast b = new Comms.Broadcast();
        b.id = Rows.uuid(rs, "id"); b.shortId = rs.getString("short_id"); b.type = rs.getString("type"); b.audience = rs.getString("audience"); b.subject = rs.getString("subject");
        b.message = rs.getString("message"); b.audienceUnits = uuids(Rows.list(rs, "audience_units", String::valueOf)); b.audienceBlocks = uuids(Rows.list(rs, "audience_blocks", String::valueOf));
        b.eventDate = Rows.date(rs, "event_date"); b.startTime = rs.getString("start_time"); b.endTime = rs.getString("end_time"); b.affects = rs.getString("affects");
        b.pollOptions = Rows.list(rs, "poll_options", String::valueOf); b.pollMultiple = rs.getBoolean("poll_multiple"); b.pollClosesOn = Rows.date(rs, "poll_closes_on");
        b.requiresSignature = rs.getBoolean("requires_signature"); b.reminderFrequency = rs.getString("reminder_frequency") == null ? "None" : rs.getString("reminder_frequency");
        b.status = rs.getString("status"); b.sentAt = Rows.instant(rs, "sent_at"); b.sentById = Rows.uuid(rs, "sent_by_id"); b.sentBy = rs.getString("sent_by");
        b.scheduledFor = Rows.instant(rs, "scheduled_for"); b.createdAt = Rows.instant(rs, "created_at"); b.version = rs.getLong("version");
        b.viewedAt = Rows.instant(rs, "my_viewed_at"); b.signedAt = Rows.instant(rs, "my_signed_at");
        b.recipients = rs.getInt("recipients"); b.viewed = rs.getInt("viewed"); b.signed = rs.getInt("signed"); b.pushDelivered = b.sent() ? b.recipients : 0;
        b.signedBy = Rows.list(rs, "signed_by", String::valueOf);
        return b;
    }
    static Map<String, Object> params(Comms.Broadcast b) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", b.id.toString()); p.put("type", b.type); p.put("audience", b.audience); p.put("subject", b.subject); p.put("message", b.message);
        p.put("units", array(b.audienceUnits)); p.put("blocks", array(b.audienceBlocks)); p.put("eventDate", b.eventDate == null ? null : b.eventDate.toString());
        p.put("startTime", b.startTime); p.put("endTime", b.endTime); p.put("affects", b.affects); p.put("pollOptions", array(b.pollOptions)); p.put("pollMultiple", b.pollMultiple);
        p.put("pollClosesOn", b.pollClosesOn == null ? null : b.pollClosesOn.toString()); p.put("requiresSignature", b.requiresSignature); p.put("reminder", b.reminderFrequency);
        p.put("status", b.status); p.put("scheduledFor", b.scheduledFor == null ? null : b.scheduledFor.toString()); p.put("sentAt", b.sentAt == null ? null : b.sentAt.toString());
        p.put("sentBy", str(b.sentById)); p.put("recipients", b.recipients); p.put("version", b.version);
        return p;
    }
    static Map<String, Object> audience(Comms.Audience a) {
        Map<String, Object> p = new HashMap<>(); p.put("kind", a.kind()); p.put("units", array(a.units())); p.put("blocks", array(a.blocks()));
        return p;
    }
    static Vote vote(ResultSet rs) throws SQLException {
        return new Vote(Rows.uuid(rs, "id"), Rows.uuid(rs, "voter_id"), rs.getString("voter_name"), Rows.uuid(rs, "unit_id"), rs.getString("unit_no"), Rows.list(rs, "choices", String::valueOf), rs.getLong("version"));
    }
    static Comms.Topic topic(ResultSet rs) throws SQLException {
        Comms.Topic t = new Comms.Topic();
        t.id = Rows.uuid(rs, "id"); t.shortId = rs.getString("short_id"); t.title = rs.getString("title"); t.category = rs.getString("category"); t.kind = rs.getString("kind") == null ? "Discussion" : rs.getString("kind");
        t.pollOptions = Rows.list(rs, "poll_options", String::valueOf); t.pinned = rs.getBoolean("pinned"); t.status = rs.getString("status"); t.replies = rs.getInt("replies");
        t.authorId = Rows.uuid(rs, "author_id"); t.author = rs.getString("author"); t.lastPostAt = Rows.instant(rs, "last_post_at"); t.createdAt = Rows.instant(rs, "created_at"); t.version = rs.getLong("version");
        return t;
    }
    static Comms.Post post(ResultSet rs) throws SQLException {
        Comms.Post x = new Comms.Post();
        x.id = Rows.uuid(rs, "id"); x.shortId = rs.getString("short_id"); x.topicId = Rows.uuid(rs, "topic_id"); x.parentId = Rows.uuid(rs, "parent_id"); x.authorId = Rows.uuid(rs, "author_id");
        x.author = rs.getString("author"); x.authorRole = rs.getString("author_role"); x.body = rs.getString("body"); x.reactions = rs.getInt("reactions"); x.hidden = rs.getBoolean("hidden");
        x.hiddenReason = rs.getString("hidden_reason"); x.editedAt = Rows.instant(rs, "edited_at"); x.createdAt = Rows.instant(rs, "created_at"); x.version = rs.getLong("version");
        return x;
    }
    static List<UUID> uuids(List<String> xs) {
        return xs.stream().filter((s) -> s.matches("[0-9a-fA-F-]{36}")).map(UUID::fromString).toList();
    }
    static String str(Object o) { return o == null ? null : o.toString(); }
    static String array(Collection<?> xs) { return JdbcInbox.array(xs == null ? List.of() : xs); }
}
