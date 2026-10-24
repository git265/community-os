package com.communityos.api.governance.adapter;

import com.communityos.api.governance.application.port.GovernanceStore;
import com.communityos.api.governance.domain.Governance;
import com.communityos.api.shared.jdbc.Rows;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * Governance on the tenant connection. The box is written without RETURNING and read only through BOX, which the database answers only
 * for a closed ballot (row policy sealed_until_closed); marks, box rows and the frozen roll are never updated or deleted (triggers).
 */
public final class JdbcGovernanceStore implements GovernanceStore {
    // ---- meetings ------------------------------------------------------------------------------------------------------------------------------
    static final String MEETING_COLUMNS = """
        SELECT m.id, m.short_id, m.title, m.committee, m.date, m.start_time, m.end_time, m.location, m.status, m.visibility, m.published_at, m.published_by_id,
               m.agenda, m.minutes, m.minutes_at, m.minutes_by_id, m.cancel_reason, m.created_at, m.updated_at, m.version
        FROM governance.meeting m""";
    static final String MEETINGS = MEETING_COLUMNS + """

        WHERE (NOT :published OR m.visibility = 'Published to residents') AND (CAST(:from AS date) IS NULL OR m.date >= CAST(:from AS date))
          AND (CAST(:to AS date) IS NULL OR m.date <= CAST(:to AS date)) AND (CAST(:committee AS text) IS NULL OR m.committee = CAST(:committee AS text))
        ORDER BY m.date DESC, m.start_time DESC NULLS LAST LIMIT 2000""";
    static final String MEETING = MEETING_COLUMNS + "\nWHERE m.id = CAST(:id AS uuid)";
    static final String MEETING_LOCK = MEETING + " FOR UPDATE OF m";
    static final String MEETING_INSERT = """
        INSERT INTO governance.meeting (community_id, id, title, committee, date, start_time, end_time, location, status, visibility, published_at, published_by_id,
                                        agenda, minutes, minutes_at, minutes_by_id, cancel_reason)
        VALUES (platform.current_community(), CAST(:id AS uuid), :title, :committee, CAST(:date AS date), CAST(:start AS time), CAST(:end AS time), :location, :status, :visibility,
                CAST(:publishedAt AS timestamptz), CAST(:publishedBy AS uuid), :agenda, :minutes, CAST(:minutesAt AS timestamptz), CAST(:minutesBy AS uuid), :cancelReason)
        RETURNING short_id, version, created_at, updated_at""";
    static final String MEETING_UPDATE = """
        UPDATE governance.meeting SET title = :title, committee = :committee, date = CAST(:date AS date), start_time = CAST(:start AS time), end_time = CAST(:end AS time),
               location = :location, status = :status, visibility = :visibility, published_at = CAST(:publishedAt AS timestamptz), published_by_id = CAST(:publishedBy AS uuid),
               agenda = :agenda, minutes = :minutes, minutes_at = CAST(:minutesAt AS timestamptz), minutes_by_id = CAST(:minutesBy AS uuid), cancel_reason = :cancelReason
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version, updated_at""";
    static final String MEETING_DELETE = "DELETE FROM governance.meeting WHERE id = CAST(:id AS uuid) AND version = :version AND published_at IS NULL AND minutes IS NULL";

    // ---- ballots -------------------------------------------------------------------------------------------------------------------------------
    static final String BALLOT_COLUMNS = """
        SELECT b.id, b.short_id, b.title, b.description, b.kind, b.options, b.opens_on, b.closes_on, b.quorum_pct, b.pass_pct, b.status, b.roll_hash, b.opened_at, b.opened_by_id,
               b.closed_at, b.closed_by_id, b.chain_head, b.votes_cast, b.votes_counted, b.meeting_id, b.created_at, b.version,
               (SELECT count(*) FROM governance.ballot_elector e WHERE e.community_id = b.community_id AND e.ballot_id = b.id) AS roll_size
        FROM governance.ballot b""";
    static final String BALLOTS = BALLOT_COLUMNS + "\nWHERE (:drafts OR b.status <> 'Draft') ORDER BY b.opens_on DESC NULLS FIRST, b.created_at DESC LIMIT 500";
    static final String BALLOT = BALLOT_COLUMNS + "\nWHERE b.id = CAST(:id AS uuid)";
    static final String BALLOT_LOCK = BALLOT + " FOR UPDATE OF b";
    static final String BALLOT_INSERT = """
        INSERT INTO governance.ballot (community_id, id, title, description, kind, options, opens_on, closes_on, quorum_pct, pass_pct, status, meeting_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), :title, :description, :kind, CAST(:options AS text[]), CAST(:opensOn AS date), CAST(:closesOn AS date), :quorum, :pass,
                'Draft', CAST(:meeting AS uuid))
        RETURNING short_id, version, created_at""";
    static final String BALLOT_UPDATE = """
        UPDATE governance.ballot SET title = :title, description = :description, kind = :kind, options = CAST(:options AS text[]), opens_on = CAST(:opensOn AS date),
               closes_on = CAST(:closesOn AS date), quorum_pct = :quorum, pass_pct = :pass, meeting_id = CAST(:meeting AS uuid)
        WHERE id = CAST(:id AS uuid) AND version = :version AND status = 'Draft' RETURNING version""";
    static final String BALLOT_DELETE = "DELETE FROM governance.ballot WHERE id = CAST(:id AS uuid) AND version = :version AND status = 'Draft'";
    static final String OPEN = """
        UPDATE governance.ballot SET status = 'Open', roll_hash = :rollHash, opened_at = CAST(:openedAt AS timestamptz), opened_by_id = CAST(:openedBy AS uuid)
        WHERE id = CAST(:id AS uuid) AND version = :version AND status = 'Draft' RETURNING version""";
    static final String CLOSE = """
        UPDATE governance.ballot SET status = 'Closed', closed_at = CAST(:closedAt AS timestamptz), closed_by_id = CAST(:closedBy AS uuid), votes_counted = votes_cast
        WHERE id = CAST(:id AS uuid) AND version = :version AND status = 'Open' RETURNING version""";
    /** Each active unit's voter now: the owner chosen as its e-vote number, or else its primary owner (an owner whose ownership has not ended). */
    static final String OWNERS_NOW = """
        SELECT u.id AS unit_id, u.unit_no,
               jsonb_build_array(jsonb_build_object('occupantId', o.id, 'personId', o.person_id, 'name', o.full_name, 'phoneLast4', right(coalesce(o.phone_e164, p.phone_e164), 4))) AS owners
        FROM property.unit u
        JOIN LATERAL (SELECT x.* FROM property.occupant x
                       WHERE x.community_id = u.community_id AND x.unit_id = u.id AND x.relation IN ('Owner', 'Co-owner')
                         AND (x.to_date IS NULL OR x.to_date > current_date) AND (x.from_date IS NULL OR x.from_date <= current_date)
                       ORDER BY (x.id = u.evote_occupant_id) DESC NULLS LAST, x.is_primary DESC, x.full_name LIMIT 1) o ON true
        LEFT JOIN identity.person p ON p.id = o.person_id
        WHERE u.status = 'Active' ORDER BY u.unit_no""";
    /** Every active unit's current owners, with the one chosen as its e-vote number (the register an admin keeps). */
    static final String VOTERS = """
        SELECT u.id AS unit_id, u.unit_no, u.evote_occupant_id,
               jsonb_agg(jsonb_build_object('occupantId', o.id, 'name', o.full_name, 'primary', o.is_primary, 'phoneLast4', right(coalesce(o.phone_e164, p.phone_e164), 4))
                         ORDER BY o.is_primary DESC, o.full_name) AS owners
        FROM property.unit u
        JOIN property.occupant o ON o.community_id = u.community_id AND o.unit_id = u.id
        LEFT JOIN identity.person p ON p.id = o.person_id
        WHERE u.status = 'Active' AND o.relation IN ('Owner', 'Co-owner') AND (o.to_date IS NULL OR o.to_date > current_date) AND (o.from_date IS NULL OR o.from_date <= current_date)
        GROUP BY u.id, u.unit_no, u.evote_occupant_id ORDER BY u.unit_no""";
    /** Choose a unit's e-vote number: one of its current owners, or none (back to the primary owner). */
    static final String SET_VOTER = """
        UPDATE property.unit u SET evote_occupant_id = CAST(:occupant AS uuid), updated_at = now()
        WHERE u.id = CAST(:unit AS uuid) AND u.status = 'Active'
          AND (CAST(:occupant AS uuid) IS NULL OR EXISTS (SELECT 1 FROM property.occupant o WHERE o.community_id = u.community_id AND o.unit_id = u.id
               AND o.id = CAST(:occupant AS uuid) AND o.relation IN ('Owner', 'Co-owner') AND (o.to_date IS NULL OR o.to_date > current_date)))
        RETURNING u.unit_no""";
    static final String ELECTOR_INSERT = """
        INSERT INTO governance.ballot_elector (community_id, ballot_id, unit_id, unit_no, owners)
        VALUES (platform.current_community(), CAST(:ballot AS uuid), CAST(:unit AS uuid), :unitNo, CAST(:owners AS jsonb))""";
    static final String ROLL = "SELECT e.unit_id, e.unit_no, e.owners FROM governance.ballot_elector e WHERE e.ballot_id = CAST(:ballot AS uuid) ORDER BY e.unit_no";
    static final String ELECTOR = "SELECT e.unit_id, e.unit_no, e.owners FROM governance.ballot_elector e WHERE e.ballot_id = CAST(:ballot AS uuid) AND e.unit_id = CAST(:unit AS uuid)";
    static final String UNITS_OF = """
        SELECT e.ballot_id, e.unit_id, e.unit_no,
               EXISTS (SELECT 1 FROM governance.vote_roll v WHERE v.community_id = e.community_id AND v.ballot_id = e.ballot_id AND v.unit_id = e.unit_id) AS voted
        FROM governance.ballot_elector e WHERE e.owners @> jsonb_build_array(jsonb_build_object('personId', CAST(:person AS text))) ORDER BY e.unit_no""";
    static final String MARKS = """
        SELECT v.ballot_id, v.unit_id, u.unit_no, v.voter_id, v.owner, v.marked_on
        FROM governance.vote_roll v JOIN property.unit u ON u.community_id = v.community_id AND u.id = v.unit_id
        WHERE v.ballot_id = CAST(:ballot AS uuid) ORDER BY u.unit_no""";
    static final String VOTED = "SELECT EXISTS (SELECT 1 FROM governance.vote_roll v WHERE v.ballot_id = CAST(:ballot AS uuid) AND v.unit_id = CAST(:unit AS uuid)) AS voted";
    static final String MARK_INSERT = """
        INSERT INTO governance.vote_roll (community_id, ballot_id, unit_id, voter_id, owner, marked_on)
        VALUES (platform.current_community(), CAST(:ballot AS uuid), CAST(:unit AS uuid), CAST(:voter AS uuid), :owner, CAST(:on AS date))""";
    static final String BOX_INSERT = """
        INSERT INTO governance.ballot_box (community_id, ballot_id, seq, choice, receipt, prev_hash, hash)
        VALUES (platform.current_community(), CAST(:ballot AS uuid), :seq, :choice, :receipt, :prev, :hash)""";
    static final String COUNT = """
        UPDATE governance.ballot SET votes_cast = :seq, chain_head = :hash WHERE id = CAST(:ballot AS uuid) AND status = 'Open' AND votes_cast = :before RETURNING version""";
    static final String BOX = "SELECT x.seq, x.receipt, x.choice, x.prev_hash, x.hash FROM governance.ballot_box x WHERE x.ballot_id = CAST(:ballot AS uuid) ORDER BY x.seq";

    // ---- the second factor ---------------------------------------------------------------------------------------------------------------------
    static final String CHALLENGE = """
        SELECT c.id, c.ballot_id, c.unit_id, c.person_id, encode(c.code_hash, 'hex') AS code_hash, c.attempts, c.sent_at, c.expires_at, encode(c.proof_hash, 'hex') AS proof_hash, c.proof_expires_at
        FROM governance.vote_challenge c WHERE c.ballot_id = CAST(:ballot AS uuid) AND c.unit_id = CAST(:unit AS uuid) AND c.person_id = CAST(:person AS uuid) FOR UPDATE""";
    static final String CHALLENGE_DROP = "DELETE FROM governance.vote_challenge WHERE ballot_id = CAST(:ballot AS uuid) AND unit_id = CAST(:unit AS uuid) AND person_id = CAST(:person AS uuid)";
    static final String CHALLENGE_INSERT = """
        INSERT INTO governance.vote_challenge (community_id, id, ballot_id, unit_id, person_id, code_hash, attempts, sent_at, expires_at)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:ballot AS uuid), CAST(:unit AS uuid), CAST(:person AS uuid), decode(:code, 'hex'), 0,
                CAST(:sentAt AS timestamptz), CAST(:expiresAt AS timestamptz))""";
    static final String CHALLENGE_UPDATE = """
        UPDATE governance.vote_challenge SET attempts = :attempts, proof_hash = decode(CAST(:proof AS text), 'hex'), proof_expires_at = CAST(:proofExpires AS timestamptz)
        WHERE id = CAST(:id AS uuid)""";
    static final String CHALLENGE_DELETE = "DELETE FROM governance.vote_challenge WHERE id = CAST(:id AS uuid)";
    static final String PHONE = """
        SELECT coalesce(o.phone_e164, p.phone_e164) AS phone
        FROM property.occupant o LEFT JOIN identity.person p ON p.id = o.person_id
        WHERE o.unit_id = CAST(:unit AS uuid) AND o.person_id = CAST(:person AS uuid) AND o.relation IN ('Owner', 'Co-owner')
        ORDER BY (o.to_date IS NULL) DESC, o.is_primary DESC LIMIT 1""";

    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public JdbcGovernanceStore(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    // ---- meetings ------------------------------------------------------------------------------------------------------------------------------
    @Override public List<Governance.Meeting> meetings(MeetingFilter f) {
        Map<String, Object> p = new HashMap<>();
        p.put("published", f.publishedOnly()); p.put("from", s(f.from())); p.put("to", s(f.to())); p.put("committee", f.committee() == null || f.committee().isBlank() ? null : f.committee());
        return jdbc.query(MEETINGS, p, (rs, i) -> meeting(rs));
    }
    @Override public Optional<Governance.Meeting> meeting(UUID id, boolean lock) {
        return jdbc.query(lock ? MEETING_LOCK : MEETING, Map.of("id", id.toString()), (rs, i) -> meeting(rs)).stream().findFirst();
    }
    @Override public void insert(Governance.Meeting m) {
        if (m.id == null) m.id = UUID.randomUUID();
        jdbc.query(MEETING_INSERT, meetingParams(m), (rs, i) -> { m.shortId = rs.getString("short_id"); m.version = rs.getLong("version"); m.createdAt = Rows.instant(rs, "created_at"); m.updatedAt = Rows.instant(rs, "updated_at"); return null; });
    }
    @Override public boolean update(Governance.Meeting m) {
        Map<String, Object> p = meetingParams(m); p.put("version", m.version);
        List<Long> v = jdbc.query(MEETING_UPDATE, p, (rs, i) -> { m.updatedAt = Rows.instant(rs, "updated_at"); return rs.getLong("version"); });
        if (v.isEmpty()) return false;
        m.version = v.get(0); return true;
    }
    @Override public boolean deleteMeeting(UUID id, long version) { return jdbc.update(MEETING_DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    static Map<String, Object> meetingParams(Governance.Meeting m) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", m.id.toString()); p.put("title", m.title); p.put("committee", m.committee); p.put("date", s(m.date)); p.put("start", s(m.startTime)); p.put("end", s(m.endTime));
        p.put("location", m.location); p.put("status", m.status); p.put("visibility", m.visibility); p.put("publishedAt", s(m.publishedAt)); p.put("publishedBy", s(m.publishedById));
        p.put("agenda", m.agenda); p.put("minutes", m.minutes); p.put("minutesAt", s(m.minutesAt)); p.put("minutesBy", s(m.minutesById)); p.put("cancelReason", m.cancelReason);
        return p;
    }
    static Governance.Meeting meeting(ResultSet rs) throws SQLException {
        Governance.Meeting m = new Governance.Meeting();
        m.id = Rows.uuid(rs, "id"); m.shortId = rs.getString("short_id"); m.title = rs.getString("title"); m.committee = rs.getString("committee"); m.date = Rows.date(rs, "date");
        m.startTime = time(rs.getString("start_time")); m.endTime = time(rs.getString("end_time")); m.location = rs.getString("location"); m.status = rs.getString("status");
        m.visibility = rs.getString("visibility"); m.publishedAt = Rows.instant(rs, "published_at"); m.publishedById = Rows.uuid(rs, "published_by_id"); m.agenda = rs.getString("agenda");
        m.minutes = rs.getString("minutes"); m.minutesAt = Rows.instant(rs, "minutes_at"); m.minutesById = Rows.uuid(rs, "minutes_by_id"); m.cancelReason = rs.getString("cancel_reason");
        m.createdAt = Rows.instant(rs, "created_at"); m.updatedAt = Rows.instant(rs, "updated_at"); m.version = rs.getLong("version");
        return m;
    }

    // ---- ballots -------------------------------------------------------------------------------------------------------------------------------
    @Override public List<Governance.Ballot> ballots(boolean withDrafts) { return jdbc.query(BALLOTS, Map.of("drafts", withDrafts), (rs, i) -> ballot(rs)); }
    @Override public Optional<Governance.Ballot> ballot(UUID id, boolean lock) { return jdbc.query(lock ? BALLOT_LOCK : BALLOT, Map.of("id", id.toString()), (rs, i) -> ballot(rs)).stream().findFirst(); }
    @Override public void insert(Governance.Ballot b) {
        if (b.id == null) b.id = UUID.randomUUID();
        jdbc.query(BALLOT_INSERT, ballotParams(b), (rs, i) -> { b.shortId = rs.getString("short_id"); b.version = rs.getLong("version"); b.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean updateDraft(Governance.Ballot b) {
        Map<String, Object> p = ballotParams(b); p.put("version", b.version);
        return bump(b, jdbc.query(BALLOT_UPDATE, p, (rs, i) -> rs.getLong("version")));
    }
    @Override public boolean deleteBallot(UUID id, long version) { return jdbc.update(BALLOT_DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    static Map<String, Object> ballotParams(Governance.Ballot b) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", b.id.toString()); p.put("title", b.title); p.put("description", b.description); p.put("kind", b.kind); p.put("options", array(b.options));
        p.put("opensOn", s(b.opensOn)); p.put("closesOn", s(b.closesOn)); p.put("quorum", b.quorumPct); p.put("pass", b.passPct); p.put("meeting", s(b.meetingId));
        return p;
    }
    @Override public List<Governance.Elector> currentOwners() { return jdbc.query(OWNERS_NOW, Map.of(), (rs, i) -> elector(rs)); }
    @Override public List<Voters> voters() {
        return jdbc.query(VOTERS, Map.of(), (rs, i) -> {
            List<VoterOwner> owners = new java.util.ArrayList<>();
            try {
                for (Map<String, Object> o : json.readValue(rs.getString("owners"), new com.fasterxml.jackson.core.type.TypeReference<List<Map<String, Object>>>() {}))
                    owners.add(new VoterOwner(uuid(o.get("occupantId")), (String) o.get("name"), Boolean.TRUE.equals(o.get("primary")), (String) o.get("phoneLast4")));
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException(e); }
            UUID chosen = com.communityos.api.shared.jdbc.Rows.uuid(rs, "evote_occupant_id");
            return new Voters(com.communityos.api.shared.jdbc.Rows.uuid(rs, "unit_id"), rs.getString("unit_no"), owners, chosen != null && owners.stream().anyMatch((o) -> chosen.equals(o.occupantId())) ? chosen : null);
        });
    }
    @Override public java.util.Optional<String> setVoter(UUID unit, UUID occupant) {
        java.util.Map<String, Object> p = new java.util.HashMap<>(); p.put("unit", unit.toString()); p.put("occupant", occupant == null ? null : occupant.toString());
        return jdbc.query(SET_VOTER, p, (rs, i) -> rs.getString("unit_no")).stream().findFirst();
    }
    @Override public boolean open(Governance.Ballot b, List<Governance.Elector> roll) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", b.id.toString()); p.put("version", b.version); p.put("rollHash", b.rollHash); p.put("openedAt", s(b.openedAt)); p.put("openedBy", s(b.openedById));
        if (!bump(b, jdbc.query(OPEN, p, (rs, i) -> rs.getLong("version")))) return false;
        for (Governance.Elector e : roll) {
            Map<String, Object> q = new HashMap<>();
            q.put("ballot", b.id.toString()); q.put("unit", e.unitId().toString()); q.put("unitNo", e.unitNo()); q.put("owners", write(e.owners()));
            jdbc.update(ELECTOR_INSERT, q);
        }
        return true;
    }
    @Override public List<Governance.Elector> roll(UUID ballotId) { return jdbc.query(ROLL, Map.of("ballot", ballotId.toString()), (rs, i) -> elector(rs)); }
    @Override public Optional<Governance.Elector> elector(UUID ballotId, UUID unitId) {
        return jdbc.query(ELECTOR, Map.of("ballot", ballotId.toString(), "unit", unitId.toString()), (rs, i) -> elector(rs)).stream().findFirst();
    }
    @Override public List<MyUnit> unitsOf(UUID personId) {
        return jdbc.query(UNITS_OF, Map.of("person", personId.toString()), (rs, i) -> new MyUnit(Rows.uuid(rs, "ballot_id"), Rows.uuid(rs, "unit_id"), rs.getString("unit_no"), rs.getBoolean("voted")));
    }
    @Override public List<Mark> marks(UUID ballotId) {
        return jdbc.query(MARKS, Map.of("ballot", ballotId.toString()), (rs, i) -> new Mark(Rows.uuid(rs, "ballot_id"), Rows.uuid(rs, "unit_id"), rs.getString("unit_no"), Rows.uuid(rs, "voter_id"),
            rs.getString("owner"), Rows.date(rs, "marked_on")));
    }
    @Override public boolean voted(UUID ballotId, UUID unitId) {
        return Boolean.TRUE.equals(jdbc.query(VOTED, Map.of("ballot", ballotId.toString(), "unit", unitId.toString()), (rs, i) -> rs.getBoolean("voted")).stream().findFirst().orElse(false));
    }
    @Override public void cast(Governance.Ballot b, Mark m, Governance.BoxRow row) {
        Map<String, Object> p = new HashMap<>();
        p.put("ballot", b.id.toString()); p.put("unit", m.unitId().toString()); p.put("voter", s(m.voterId())); p.put("owner", m.voter()); p.put("on", s(m.markedOn()));
        jdbc.update(MARK_INSERT, p);
        Map<String, Object> x = new HashMap<>();
        x.put("ballot", b.id.toString()); x.put("seq", row.seq()); x.put("choice", row.choice()); x.put("receipt", row.receipt()); x.put("prev", row.prevHash()); x.put("hash", row.hash());
        jdbc.update(BOX_INSERT, x);
        Map<String, Object> c = new HashMap<>();
        c.put("ballot", b.id.toString()); c.put("seq", row.seq()); c.put("hash", row.hash()); c.put("before", b.votesCast);
        List<Long> v = jdbc.query(COUNT, c, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) throw new com.communityos.api.shared.domain.DomainException.Conflict("The ballot");
        b.version = v.get(0); b.votesCast = row.seq(); b.chainHead = row.hash();
    }
    @Override public boolean close(Governance.Ballot b) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", b.id.toString()); p.put("version", b.version); p.put("closedAt", s(b.closedAt)); p.put("closedBy", s(b.closedById));
        return bump(b, jdbc.query(CLOSE, p, (rs, i) -> rs.getLong("version")));
    }
    @Override public List<Governance.BoxRow> box(UUID ballotId) {
        return jdbc.query(BOX, Map.of("ballot", ballotId.toString()), (rs, i) -> new Governance.BoxRow(rs.getInt("seq"), rs.getString("receipt"), rs.getString("choice"), rs.getString("prev_hash"), rs.getString("hash")));
    }
    static Governance.Ballot ballot(ResultSet rs) throws SQLException {
        Governance.Ballot b = new Governance.Ballot();
        b.id = Rows.uuid(rs, "id"); b.shortId = rs.getString("short_id"); b.title = rs.getString("title"); b.description = rs.getString("description"); b.kind = rs.getString("kind");
        b.options = Rows.list(rs, "options", Object::toString); b.opensOn = Rows.date(rs, "opens_on"); b.closesOn = Rows.date(rs, "closes_on"); b.quorumPct = rs.getBigDecimal("quorum_pct");
        b.passPct = rs.getBigDecimal("pass_pct"); b.status = rs.getString("status"); b.rollHash = rs.getString("roll_hash"); b.openedAt = Rows.instant(rs, "opened_at");
        b.openedById = Rows.uuid(rs, "opened_by_id"); b.closedAt = Rows.instant(rs, "closed_at"); b.closedById = Rows.uuid(rs, "closed_by_id"); b.chainHead = rs.getString("chain_head");
        b.votesCast = rs.getInt("votes_cast"); int counted = rs.getInt("votes_counted"); b.votesCounted = rs.wasNull() ? null : counted; b.meetingId = Rows.uuid(rs, "meeting_id");
        b.createdAt = Rows.instant(rs, "created_at"); b.version = rs.getLong("version"); b.rollSize = rs.getInt("roll_size");
        if (b.quorumPct == null) b.quorumPct = java.math.BigDecimal.ZERO;
        if (b.passPct == null) b.passPct = java.math.BigDecimal.valueOf(50);
        return b;
    }
    Governance.Elector elector(ResultSet rs) throws SQLException {
        try {
            List<Map<String, Object>> raw = json.readValue(rs.getString("owners"), new TypeReference<List<Map<String, Object>>>() {});
            List<Governance.Owner> owners = new ArrayList<>();
            for (Map<String, Object> o : raw) owners.add(new Governance.Owner(uuid(o.get("occupantId")), uuid(o.get("personId")), (String) o.get("name"), (String) o.get("phoneLast4")));
            return new Governance.Elector(Rows.uuid(rs, "unit_id"), rs.getString("unit_no"), List.copyOf(owners));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new SQLException("bad owners", e); }
    }
    String write(List<Governance.Owner> owners) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Governance.Owner o : owners) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("occupantId", s(o.occupantId())); m.put("personId", s(o.personId())); m.put("name", o.name()); m.put("phoneLast4", o.phoneLast4());
            out.add(m);
        }
        try { return json.writeValueAsString(out); } catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException(e); }
    }

    // ---- the second factor ---------------------------------------------------------------------------------------------------------------------
    @Override public Optional<Challenge> challenge(UUID ballotId, UUID unitId, UUID personId) {
        return jdbc.query(CHALLENGE, Map.of("ballot", ballotId.toString(), "unit", unitId.toString(), "person", personId.toString()), (rs, i) -> new Challenge(Rows.uuid(rs, "id"),
            Rows.uuid(rs, "ballot_id"), Rows.uuid(rs, "unit_id"), Rows.uuid(rs, "person_id"), hex(rs.getString("code_hash")), rs.getInt("attempts"), Rows.instant(rs, "sent_at"),
            Rows.instant(rs, "expires_at"), hex(rs.getString("proof_hash")), Rows.instant(rs, "proof_expires_at"))).stream().findFirst();
    }
    @Override public void newChallenge(Challenge c) {
        jdbc.update(CHALLENGE_DROP, Map.of("ballot", c.ballotId().toString(), "unit", c.unitId().toString(), "person", c.personId().toString()));
        Map<String, Object> p = new HashMap<>();
        p.put("id", c.id().toString()); p.put("ballot", c.ballotId().toString()); p.put("unit", c.unitId().toString()); p.put("person", c.personId().toString());
        p.put("code", HexFormat.of().formatHex(c.codeHash())); p.put("sentAt", s(c.sentAt())); p.put("expiresAt", s(c.expiresAt()));
        jdbc.update(CHALLENGE_INSERT, p);
    }
    @Override public void updateChallenge(Challenge c) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", c.id().toString()); p.put("attempts", c.attempts()); p.put("proof", c.proofHash() == null ? null : HexFormat.of().formatHex(c.proofHash())); p.put("proofExpires", s(c.proofExpiresAt()));
        jdbc.update(CHALLENGE_UPDATE, p);
    }
    @Override public void deleteChallenge(UUID id) { jdbc.update(CHALLENGE_DELETE, Map.of("id", id.toString())); }
    @Override public String phoneOf(UUID unitId, UUID personId) {
        return jdbc.query(PHONE, Map.of("unit", unitId.toString(), "person", personId.toString()), (rs, i) -> rs.getString("phone")).stream().filter(java.util.Objects::nonNull).findFirst().orElse(null);
    }

    static boolean bump(Governance.Ballot b, List<Long> v) { if (v.isEmpty()) return false; b.version = v.get(0); return true; }
    static String s(Object o) { return o == null ? null : o.toString(); }
    static UUID uuid(Object o) { return o == null ? null : UUID.fromString(o.toString()); }
    static byte[] hex(String s) { return s == null ? null : HexFormat.of().parseHex(s); }
    static LocalTime time(String s) { return s == null ? null : LocalTime.parse(s.length() > 8 ? s.substring(0, 8) : s); }
    /** A Postgres text[] literal ({"a","b"}) for CAST(:x AS text[]). */
    static String array(List<String> xs) { return com.communityos.api.shared.jdbc.Rows.pgArray(xs); }
}
