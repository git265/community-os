package com.communityos.api.site.adapter;

import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.site.application.port.SiteStore;
import com.communityos.api.site.domain.Site;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The site's devices, bridges, face profiles, enrolments, work queue and ledger, on the tenant connection (the community's rows only). */
public final class JdbcSiteStore implements SiteStore {
    // ---- bridges ------------------------------------------------------------------------------------------------------------------------------
    static final String BRIDGES = "SELECT b.id, b.short_id, b.name, b.status, b.token_hint, b.last_seen_at, b.agent_version, b.created_at FROM gate.bridge b ORDER BY b.created_at";
    static final String INSERT_BRIDGE = """
        INSERT INTO gate.bridge (community_id, id, name, token_hash, token_hint) VALUES (platform.current_community(), CAST(:id AS uuid), :name, :hash, :hint)
        RETURNING id, short_id, name, status, token_hint, last_seen_at, agent_version, created_at""";
    static final String REVOKE_BRIDGE = "UPDATE gate.bridge SET status = 'Revoked' WHERE id = CAST(:id AS uuid) AND status = 'Active' RETURNING id";
    /** At most every 20 seconds (the bridge calls every few). */
    static final String BRIDGE_SEEN = """
        UPDATE gate.bridge SET last_seen_at = now(), agent_version = coalesce(:v, agent_version)
        WHERE id = CAST(:id AS uuid) AND (last_seen_at IS NULL OR last_seen_at < now() - interval '20 seconds' OR agent_version IS DISTINCT FROM coalesce(:v, agent_version))""";

    // ---- devices ------------------------------------------------------------------------------------------------------------------------------
    static final String DEVICE_COLUMNS = """
        SELECT d.id, d.short_id, d.name, d.gate, d.kind, d.make, d.model, d.driver, d.direction, d.capabilities, d.bridge_id, d.host, d.port, d.use_tls, d.username,
               d.secret_enc IS NOT NULL AS has_password, d.door_no, d.capacity, d.status, d.serial, d.firmware, d.online, d.last_seen_at, d.clock_drift_s, d.enrolled_count,
               d.last_error, d.last_event_no, d.version
        FROM gate.device d""";
    static final String DEVICES = DEVICE_COLUMNS + "\nORDER BY d.gate, d.name";
    static final String DEVICE = DEVICE_COLUMNS + "\nWHERE d.id = CAST(:id AS uuid)";
    static final String DEVICES_OF_BRIDGE = DEVICE_COLUMNS + "\nWHERE d.bridge_id = CAST(:b AS uuid) AND d.status = 'Active' ORDER BY d.name";
    static final String INSERT_DEVICE = """
        INSERT INTO gate.device (community_id, id, name, gate, kind, make, model, driver, direction, capabilities, bridge_id, host, port, use_tls, username, secret_enc, door_no, capacity, status)
        VALUES (platform.current_community(), CAST(:id AS uuid), :name, :gate, :kind, :make, :model, :driver, :direction, CAST(:caps AS text[]), CAST(:bridge AS uuid), :host, :port, :tls,
                :username, :secret, :door, :capacity, :status)""";
    static final String UPDATE_DEVICE = """
        UPDATE gate.device SET name = :name, gate = :gate, kind = :kind, make = :make, model = :model, driver = :driver, direction = :direction, capabilities = CAST(:caps AS text[]),
               bridge_id = CAST(:bridge AS uuid), host = :host, port = :port, use_tls = :tls, username = :username, secret_enc = coalesce(:secret, secret_enc), door_no = :door,
               capacity = :capacity, status = :status
        WHERE id = CAST(:id AS uuid) RETURNING id""";
    static final String SECRET = "SELECT d.secret_enc FROM gate.device d WHERE d.id = CAST(:id AS uuid)";
    static final String DEVICE_KEY_MAKE = "INSERT INTO gate.device_key (community_id) VALUES (platform.current_community()) ON CONFLICT (community_id) DO NOTHING";
    static final String DEVICE_KEY = "SELECT k.secret FROM gate.device_key k";
    static final String HEALTH = """
        UPDATE gate.device SET online = :online, serial = coalesce(:serial, serial), model = coalesce(:model, model), firmware = coalesce(:firmware, firmware), clock_drift_s = :drift,
               enrolled_count = :enrolled, last_error = :error, last_seen_at = CASE WHEN :online THEN now() ELSE last_seen_at END
        WHERE id = CAST(:id AS uuid)""";
    static final String LAST_EVENT_NO = "UPDATE gate.device SET last_event_no = GREATEST(last_event_no, :no) WHERE id = CAST(:id AS uuid) AND last_event_no < :no";

    // ---- who should be on the devices -------------------------------------------------------------------------------------------------------
    /** Vetted people with consent and a photo, inside their papers' validity, who work for a unit or are on an active crew roster. */
    static final String WANTED_PEOPLE = """
        SELECT p.id, p.name, p.photo, p.police_expiry, fp.card_no
        FROM gate.person p
        JOIN gate.face_profile fp ON fp.community_id = p.community_id AND fp.subject_kind = 'person' AND fp.subject_id = p.id
        WHERE p.status = 'Active' AND fp.consent_at IS NOT NULL AND fp.withdrawn_at IS NULL AND p.photo IS NOT NULL
          AND (p.police_expiry IS NULL OR p.police_expiry >= CAST(:today AS date))
          AND (EXISTS (SELECT 1 FROM gate.household_link l WHERE l.community_id = p.community_id AND l.person_id = p.id AND l.status = 'Active')
               OR EXISTS (SELECT 1 FROM gate.work_order w WHERE w.community_id = p.community_id AND w.status = 'Active' AND p.id = ANY (w.roster_ids)))
        ORDER BY p.name""";
    /** Active staff members with consent and their own face photo. */
    static final String WANTED_STAFF = """
        SELECT m.id, m.display_name, fp.photo, fp.card_no
        FROM identity.membership m
        JOIN gate.face_profile fp ON fp.community_id = m.community_id AND fp.subject_kind = 'member' AND fp.subject_id = m.id
        WHERE m.status = 'Active' AND fp.consent_at IS NOT NULL AND fp.withdrawn_at IS NULL AND fp.photo IS NOT NULL
          AND EXISTS (SELECT 1 FROM identity.membership_role mr JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                      JOIN identity.role_group g ON g.community_id = r.community_id AND g.id = r.group_id
                      WHERE mr.community_id = m.community_id AND mr.membership_id = m.id AND g.category = 'Staff')
        ORDER BY m.display_name""";
    static final String STAFF_NAME = """
        SELECT m.display_name FROM identity.membership m
        WHERE m.id = CAST(:id AS uuid) AND m.status = 'Active'
          AND EXISTS (SELECT 1 FROM identity.membership_role mr JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                      JOIN identity.role_group g ON g.community_id = r.community_id AND g.id = r.group_id
                      WHERE mr.community_id = m.community_id AND mr.membership_id = m.id AND g.category = 'Staff')""";
    static final String PERSON_NAME = "SELECT p.name FROM gate.person p WHERE p.id = CAST(:id AS uuid)";
    static final String FACE_OF_PERSON = "SELECT p.photo FROM gate.person p WHERE p.id = CAST(:id AS uuid) AND p.photo IS NOT NULL";
    static final String FACE_OF_MEMBER = "SELECT fp.photo FROM gate.face_profile fp WHERE fp.subject_kind = 'member' AND fp.subject_id = CAST(:id AS uuid) AND fp.photo IS NOT NULL";
    static final String RETENTION_MARK = """
        UPDATE gate.face_profile SET left_at = CASE WHEN subject_id = ANY (CAST(:wanted AS uuid[])) THEN NULL ELSE now() END, updated_at = now()
        WHERE (subject_id = ANY (CAST(:wanted AS uuid[]))) = (left_at IS NOT NULL)""";
    static final String RETENTION_DROP = """
        UPDATE gate.face_profile SET photo = NULL, updated_at = now()
        WHERE subject_kind = 'member' AND photo IS NOT NULL AND left_at < now() - make_interval(days => :days)""";

    // ---- face profiles ------------------------------------------------------------------------------------------------------------------------
    static final String PROFILE = "SELECT fp.subject_kind, fp.subject_id, fp.photo, fp.card_no, fp.consent_at, fp.withdrawn_at FROM gate.face_profile fp WHERE fp.subject_kind = :kind AND fp.subject_id = CAST(:id AS uuid)";
    static final String PROFILE_BY_CARD = "SELECT fp.subject_kind, fp.subject_id, fp.photo, fp.card_no, fp.consent_at, fp.withdrawn_at FROM gate.face_profile fp WHERE fp.card_no = :card";
    static final String SAVE_PROFILE = """
        INSERT INTO gate.face_profile (community_id, subject_kind, subject_id, photo, card_no, consent_at, consent_by, consent_text, withdrawn_at)
        VALUES (platform.current_community(), :kind, CAST(:id AS uuid), :photo, :card, CAST(:consentAt AS timestamptz), CAST(:by AS uuid), :text, CAST(:withdrawn AS timestamptz))
        ON CONFLICT (community_id, subject_kind, subject_id) DO UPDATE SET
          photo = CASE WHEN CAST(:keep AS boolean) THEN gate.face_profile.photo ELSE excluded.photo END, card_no = excluded.card_no, consent_at = excluded.consent_at,
          consent_by = excluded.consent_by, consent_text = excluded.consent_text, withdrawn_at = excluded.withdrawn_at, updated_at = now(), version = gate.face_profile.version + 1""";
    static final String PROFILES = """
        SELECT fp.subject_kind, fp.subject_id, coalesce(p.name, m.display_name) AS name, (fp.photo IS NOT NULL OR (fp.subject_kind = 'person' AND p.photo IS NOT NULL)) AS has_photo,
               fp.card_no, fp.consent_at, fp.consent_text, fp.withdrawn_at,
               (SELECT count(*) FILTER (WHERE e.state = 'Enrolled') || ' of ' || count(*) FROM gate.device_enrolment e
                WHERE e.community_id = fp.community_id AND e.subject_id = fp.subject_id AND e.state <> 'Removed') AS on_devices
        FROM gate.face_profile fp
        LEFT JOIN gate.person p ON fp.subject_kind = 'person' AND p.community_id = fp.community_id AND p.id = fp.subject_id
        LEFT JOIN identity.membership m ON fp.subject_kind = 'member' AND m.community_id = fp.community_id AND m.id = fp.subject_id
        ORDER BY 3""";

    // ---- enrolments ---------------------------------------------------------------------------------------------------------------------------
    static final String ENROLMENT_COLUMNS = "SELECT e.device_id, e.employee_no, e.subject_kind, e.subject_id, e.name, e.valid_from, e.valid_to, e.face_hash, e.card_no, e.state, e.last_error, e.synced_at FROM gate.device_enrolment e";
    static final String ENROLMENTS = ENROLMENT_COLUMNS + "\nWHERE e.device_id = CAST(:d AS uuid)";
    static final String ENROLMENT = ENROLMENT_COLUMNS + "\nWHERE e.device_id = CAST(:d AS uuid) AND e.employee_no = :emp";
    static final String SAVE_ENROLMENT = """
        INSERT INTO gate.device_enrolment (community_id, device_id, employee_no, subject_kind, subject_id, name, valid_from, valid_to, face_hash, card_no, state, last_error)
        VALUES (platform.current_community(), CAST(:d AS uuid), :emp, :kind, CAST(:subject AS uuid), :name, CAST(:from AS date), CAST(:to AS date), :hash, :card, :state, :error)
        ON CONFLICT (community_id, device_id, employee_no) DO UPDATE SET subject_kind = excluded.subject_kind, subject_id = excluded.subject_id, name = excluded.name,
          valid_from = excluded.valid_from, valid_to = excluded.valid_to, face_hash = excluded.face_hash, card_no = excluded.card_no, state = excluded.state,
          last_error = excluded.last_error, updated_at = now()""";
    static final String ENROLMENT_STATE = """
        UPDATE gate.device_enrolment SET state = :state, last_error = :error, updated_at = now(),
               synced_at = CASE WHEN :state IN ('Enrolled', 'Removed') THEN now() ELSE synced_at END
        WHERE device_id = CAST(:d AS uuid) AND employee_no = :emp""";

    // ---- the work queue -----------------------------------------------------------------------------------------------------------------------
    static final String QUEUE = """
        INSERT INTO gate.device_task (community_id, bridge_id, device_id, kind, employee_no, note)
        VALUES (platform.current_community(), CAST(:b AS uuid), CAST(:d AS uuid), :kind, :emp, :note) ON CONFLICT DO NOTHING""";
    /** Queued jobs, or sent ones whose lease ran out (the bridge went away mid-job), oldest first; each claimed by one bridge at a time. */
    static final String CLAIM = """
        UPDATE gate.device_task t SET state = 'Sent', attempts = t.attempts + 1, lease_until = now() + make_interval(secs => :lease)
        WHERE t.id IN (SELECT q.id FROM gate.device_task q WHERE q.bridge_id = CAST(:b AS uuid) AND (q.state = 'Queued' OR (q.state = 'Sent' AND q.lease_until < now()))
                       ORDER BY q.created_at LIMIT :max FOR UPDATE SKIP LOCKED)
        RETURNING t.id, t.bridge_id, t.device_id, t.kind, t.employee_no, t.note, t.attempts, t.created_at""";
    static final String TASK = "SELECT t.id, t.bridge_id, t.device_id, t.kind, t.employee_no, t.note, t.attempts, t.created_at FROM gate.device_task t WHERE t.id = CAST(:id AS uuid)";
    static final String TASK_DONE = """
        UPDATE gate.device_task SET state = CASE WHEN CAST(:ok AS boolean) THEN 'Done' WHEN CAST(:again AS boolean) THEN 'Queued' ELSE 'Failed' END, last_error = :error,
               lease_until = NULL, done_at = CASE WHEN CAST(:ok AS boolean) OR NOT CAST(:again AS boolean) THEN now() END
        WHERE id = CAST(:id AS uuid) AND state = 'Sent'""";
    static final String TASK_NOTE = "UPDATE gate.device_task SET note = :note WHERE id = CAST(:id AS uuid)";
    static final String OPEN_TASKS = "SELECT count(*) FROM gate.device_task t WHERE t.device_id = CAST(:d AS uuid) AND t.state IN ('Queued', 'Sent')";

    // ---- the ledger ---------------------------------------------------------------------------------------------------------------------------
    static final String INSERT_EVENT = """
        INSERT INTO gate.device_event (community_id, device_id, event_no, at, credential, employee_no, card_no, result, reason, photo, raw)
        VALUES (platform.current_community(), CAST(:d AS uuid), :no, CAST(:at AS timestamptz), :credential, :emp, :card, :result, :reason, :photo, CAST(:raw AS jsonb))
        ON CONFLICT (community_id, device_id, event_no) DO NOTHING RETURNING id""";
    static final String EVENT_OUTCOME = """
        UPDATE gate.device_event SET subject_kind = :kind, subject_id = CAST(:subject AS uuid), name = :name, direction = :direction, outcome = :outcome, counted = :counted,
               visit_id = CAST(:visit AS uuid), session_id = CAST(:session AS uuid)
        WHERE id = CAST(:id AS uuid)""";
    static final String LAST_COUNTED = """
        SELECT e.at, e.direction FROM gate.device_event e WHERE e.subject_id = CAST(:subject AS uuid) AND e.counted AND e.at >= CAST(:since AS timestamptz)
        ORDER BY e.at DESC LIMIT 1""";
    static final String EVENTS = """
        SELECT e.id, e.device_id, d.name AS device_name, d.gate, e.event_no, e.at, e.received_at, e.credential, e.subject_kind, e.subject_id, e.name, e.direction, e.result,
               e.reason, e.outcome, e.counted, e.visit_id, e.session_id, e.photo IS NOT NULL AS has_photo
        FROM gate.device_event e JOIN gate.device d ON d.community_id = e.community_id AND d.id = e.device_id
        WHERE e.at >= CAST(:since AS timestamptz) ORDER BY e.at DESC LIMIT :limit""";
    static final String EVENT_PHOTO = "SELECT e.photo FROM gate.device_event e WHERE e.id = CAST(:id AS uuid)";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcSiteStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    // bridges
    @Override public List<Site.Bridge> bridges() { return jdbc.query(BRIDGES, Map.of(), (rs, i) -> bridge(rs)); }
    @Override public Site.Bridge insertBridge(UUID id, String name, String hash, String hint) {
        return jdbc.query(INSERT_BRIDGE, Map.of("id", id.toString(), "name", name, "hash", hash, "hint", hint), (rs, i) -> bridge(rs)).get(0);
    }
    @Override public boolean revokeBridge(UUID id) { return !jdbc.query(REVOKE_BRIDGE, Map.of("id", id.toString()), (rs, i) -> 1).isEmpty(); }
    @Override public void bridgeSeen(UUID id, String v) { Map<String, Object> p = new HashMap<>(); p.put("id", id.toString()); p.put("v", v); jdbc.update(BRIDGE_SEEN, p); }

    // devices
    @Override public List<Site.Device> devices() { return jdbc.query(DEVICES, Map.of(), (rs, i) -> device(rs)); }
    @Override public Optional<Site.Device> device(UUID id) { return jdbc.query(DEVICE, Map.of("id", id.toString()), (rs, i) -> device(rs)).stream().findFirst(); }
    @Override public List<Site.Device> devicesOfBridge(UUID b) { return jdbc.query(DEVICES_OF_BRIDGE, Map.of("b", b.toString()), (rs, i) -> device(rs)); }
    @Override public void insertDevice(UUID id, Site.DeviceFields f, String secret) { jdbc.update(INSERT_DEVICE, deviceParams(id, f, secret)); }
    @Override public boolean updateDevice(UUID id, Site.DeviceFields f, String secret) { return !jdbc.query(UPDATE_DEVICE, deviceParams(id, f, secret), (rs, i) -> 1).isEmpty(); }
    private static Map<String, Object> deviceParams(UUID id, Site.DeviceFields f, String secret) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", id.toString()); p.put("name", f.name()); p.put("gate", f.gate()); p.put("kind", f.kind()); p.put("make", f.make()); p.put("model", f.model()); p.put("driver", f.driver());
        p.put("direction", f.direction()); p.put("caps", Rows.pgArray(f.capabilities())); p.put("bridge", f.bridgeId() == null ? null : f.bridgeId().toString()); p.put("host", f.host());
        p.put("port", f.port()); p.put("tls", Boolean.TRUE.equals(f.useTls())); p.put("username", f.username()); p.put("secret", secret); p.put("door", f.doorNo() == null ? 1 : f.doorNo());
        p.put("capacity", f.capacity()); p.put("status", f.status());
        return p;
    }
    @Override public String secret(UUID id) { return jdbc.query(SECRET, Map.of("id", id.toString()), (rs, i) -> rs.getString("secret_enc")).stream().findFirst().orElse(null); }
    @Override public byte[] deviceKey() { jdbc.update(DEVICE_KEY_MAKE, Map.of()); return jdbc.query(DEVICE_KEY, Map.of(), (rs, i) -> rs.getBytes("secret")).get(0); }
    @Override public void health(Site.Health h) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", h.deviceId().toString()); p.put("online", h.online()); p.put("serial", h.serial()); p.put("model", h.model()); p.put("firmware", h.firmware());
        p.put("drift", h.clockDriftS()); p.put("enrolled", h.enrolledCount()); p.put("error", h.lastError());
        jdbc.update(HEALTH, p);
    }
    @Override public void lastEventNo(UUID id, long no) { jdbc.update(LAST_EVENT_NO, Map.of("id", id.toString(), "no", no)); }

    // who should be on the devices
    @Override public List<Site.Wanted> wantedPeople(LocalDate today) {
        return jdbc.query(WANTED_PEOPLE, Map.of("today", Rows.sqlDate(today)), (rs, i) -> new Site.Wanted("person", Rows.uuid(rs, "id"), rs.getString("name"), today,
            Rows.date(rs, "police_expiry"), rs.getString("photo"), rs.getString("card_no")));
    }
    @Override public List<Site.Wanted> wantedStaff() {
        return jdbc.query(WANTED_STAFF, Map.of(), (rs, i) -> new Site.Wanted("member", Rows.uuid(rs, "id"), rs.getString("display_name"), null, null, rs.getString("photo"), rs.getString("card_no")));
    }
    @Override public int retention(List<UUID> wanted, int days) {
        int n = jdbc.update(RETENTION_MARK, Map.of("wanted", Rows.pgArray(wanted)));
        return n + jdbc.update(RETENTION_DROP, Map.of("days", days));
    }

    // face profiles
    @Override public Optional<ProfileRow> profile(String kind, UUID id) { return jdbc.query(PROFILE, Map.of("kind", kind, "id", id.toString()), (rs, i) -> profileRow(rs)).stream().findFirst(); }
    @Override public Optional<ProfileRow> profileByCard(String card) { return jdbc.query(PROFILE_BY_CARD, Map.of("card", card), (rs, i) -> profileRow(rs)).stream().findFirst(); }
    @Override public void saveProfile(String kind, UUID id, String photo, boolean keep, String card, Instant consentAt, UUID by, String text, Instant withdrawn) {
        Map<String, Object> p = new HashMap<>();
        p.put("kind", kind); p.put("id", id.toString()); p.put("photo", photo); p.put("keep", keep); p.put("card", card); p.put("consentAt", Rows.ts(consentAt));
        p.put("by", by == null ? null : by.toString()); p.put("text", text); p.put("withdrawn", Rows.ts(withdrawn));
        jdbc.update(SAVE_PROFILE, p);
    }
    @Override public List<Site.FaceProfile> profiles() {
        return jdbc.query(PROFILES, Map.of(), (rs, i) -> new Site.FaceProfile(rs.getString("subject_kind"), Rows.uuid(rs, "subject_id"), rs.getString("name"), rs.getBoolean("has_photo"),
            rs.getString("card_no"), Rows.instant(rs, "consent_at"), rs.getString("consent_text"), Rows.instant(rs, "withdrawn_at"), rs.getString("on_devices")));
    }
    @Override public Optional<String> staffName(UUID id) { return jdbc.query(STAFF_NAME, Map.of("id", id.toString()), (rs, i) -> rs.getString("display_name")).stream().findFirst(); }

    @Override public Optional<String> personName(UUID id) { return jdbc.query(PERSON_NAME, Map.of("id", id.toString()), (rs, i) -> rs.getString("name")).stream().findFirst(); }
    @Override public Optional<String> facePhoto(String kind, UUID id) {
        return jdbc.query("member".equals(kind) ? FACE_OF_MEMBER : FACE_OF_PERSON, Map.of("id", id.toString()), (rs, i) -> rs.getString("photo")).stream().findFirst();
    }

    // enrolments
    @Override public List<Site.Enrolment> enrolments(UUID d) { return jdbc.query(ENROLMENTS, Map.of("d", d.toString()), (rs, i) -> enrolment(rs)); }
    @Override public Optional<Site.Enrolment> enrolment(UUID d, String emp) { return jdbc.query(ENROLMENT, Map.of("d", d.toString(), "emp", emp), (rs, i) -> enrolment(rs)).stream().findFirst(); }
    @Override public void saveEnrolment(Site.Enrolment e) {
        Map<String, Object> p = new HashMap<>();
        p.put("d", e.deviceId().toString()); p.put("emp", e.employeeNo()); p.put("kind", e.subjectKind()); p.put("subject", e.subjectId().toString()); p.put("name", e.name());
        p.put("from", Rows.sqlDate(e.validFrom())); p.put("to", Rows.sqlDate(e.validTo())); p.put("hash", e.faceHash()); p.put("card", e.cardNo()); p.put("state", e.state()); p.put("error", e.lastError());
        jdbc.update(SAVE_ENROLMENT, p);
    }
    @Override public void enrolmentState(UUID d, String emp, String state, String error) {
        Map<String, Object> p = new HashMap<>(); p.put("d", d.toString()); p.put("emp", emp); p.put("state", state); p.put("error", error);
        jdbc.update(ENROLMENT_STATE, p);
    }

    // the work queue
    @Override public void queue(UUID b, UUID d, String kind, String emp, String note) {
        Map<String, Object> p = new HashMap<>(); p.put("b", b.toString()); p.put("d", d.toString()); p.put("kind", kind); p.put("emp", emp); p.put("note", note);
        jdbc.update(QUEUE, p);
    }
    @Override public List<TaskRow> claim(UUID b, int max, int lease) {
        return jdbc.query(CLAIM, Map.of("b", b.toString(), "max", max, "lease", lease), (rs, i) -> task(rs)).stream().sorted(Comparator.comparing(TaskRow::createdAt)).toList();
    }
    @Override public Optional<TaskRow> task(UUID id) { return jdbc.query(TASK, Map.of("id", id.toString()), (rs, i) -> task(rs)).stream().findFirst(); }
    @Override public void taskNote(UUID id, String note) { Map<String, Object> p = new HashMap<>(); p.put("id", id.toString()); p.put("note", note); jdbc.update(TASK_NOTE, p); }
    @Override public void taskDone(UUID id, boolean ok, String error, boolean again) {
        Map<String, Object> p = new HashMap<>(); p.put("id", id.toString()); p.put("ok", ok); p.put("again", again); p.put("error", error);
        jdbc.update(TASK_DONE, p);
    }
    @Override public int openTasks(UUID d) { Long n = jdbc.queryForObject(OPEN_TASKS, Map.of("d", d.toString()), Long.class); return n == null ? 0 : n.intValue(); }

    // the ledger
    @Override public Optional<UUID> insertEvent(UUID d, Site.Punch e, Instant at) {
        Map<String, Object> p = new HashMap<>();
        p.put("d", d.toString()); p.put("no", e.eventNo()); p.put("at", Rows.ts(at)); p.put("credential", e.credential()); p.put("emp", e.employeeNo()); p.put("card", e.cardNo());
        p.put("result", e.result()); p.put("reason", e.reason()); p.put("photo", e.photo()); p.put("raw", e.raw());
        return jdbc.query(INSERT_EVENT, p, (rs, i) -> Rows.uuid(rs, "id")).stream().findFirst();
    }
    @Override public void eventOutcome(UUID id, String kind, UUID subject, String name, String direction, String outcome, boolean counted, UUID visit, UUID session) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", id.toString()); p.put("kind", kind); p.put("subject", subject == null ? null : subject.toString()); p.put("name", name); p.put("direction", direction);
        p.put("outcome", outcome); p.put("counted", counted); p.put("visit", visit == null ? null : visit.toString()); p.put("session", session == null ? null : session.toString());
        jdbc.update(EVENT_OUTCOME, p);
    }
    @Override public Optional<Counted> lastCounted(UUID subject, Instant since) {
        return jdbc.query(LAST_COUNTED, Map.of("subject", subject.toString(), "since", Rows.ts(since)), (rs, i) -> new Counted(Rows.instant(rs, "at"), rs.getString("direction"))).stream().findFirst();
    }
    @Override public List<Site.Event> events(Instant since, int limit) {
        return jdbc.query(EVENTS, Map.of("since", Rows.ts(since), "limit", limit), (rs, i) -> new Site.Event(Rows.uuid(rs, "id"), Rows.uuid(rs, "device_id"), rs.getString("device_name"),
            rs.getString("gate"), rs.getLong("event_no"), Rows.instant(rs, "at"), Rows.instant(rs, "received_at"), rs.getString("credential"), rs.getString("subject_kind"),
            Rows.uuid(rs, "subject_id"), rs.getString("name"), rs.getString("direction"), rs.getString("result"), rs.getString("reason"), rs.getString("outcome"), rs.getBoolean("counted"),
            Rows.uuid(rs, "visit_id"), Rows.uuid(rs, "session_id"), rs.getBoolean("has_photo")));
    }
    @Override public Optional<String> eventPhoto(UUID id) { return jdbc.query(EVENT_PHOTO, Map.of("id", id.toString()), (rs, i) -> rs.getString("photo")).stream().findFirst(); }

    // ---- mapping ------------------------------------------------------------------------------------------------------------------------------
    static Site.Bridge bridge(ResultSet rs) throws SQLException {
        return new Site.Bridge(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("name"), rs.getString("status"), rs.getString("token_hint"), Rows.instant(rs, "last_seen_at"),
            rs.getString("agent_version"), Rows.instant(rs, "created_at"));
    }
    static Site.Device device(ResultSet rs) throws SQLException {
        return new Site.Device(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("name"), rs.getString("gate"), rs.getString("kind"), rs.getString("make"), rs.getString("model"),
            rs.getString("driver"), rs.getString("direction"), Rows.list(rs, "capabilities", String::valueOf), Rows.uuid(rs, "bridge_id"), rs.getString("host"), i(rs, "port"),
            rs.getBoolean("use_tls"), rs.getString("username"), rs.getBoolean("has_password"), rs.getInt("door_no"), i(rs, "capacity"), rs.getString("status"), rs.getString("serial"),
            rs.getString("firmware"), rs.getBoolean("online"), Rows.instant(rs, "last_seen_at"), i(rs, "clock_drift_s"), i(rs, "enrolled_count"), rs.getString("last_error"),
            rs.getLong("last_event_no"), rs.getLong("version"));
    }
    static Site.Enrolment enrolment(ResultSet rs) throws SQLException {
        return new Site.Enrolment(Rows.uuid(rs, "device_id"), rs.getString("employee_no"), rs.getString("subject_kind"), Rows.uuid(rs, "subject_id"), rs.getString("name"),
            Rows.date(rs, "valid_from"), Rows.date(rs, "valid_to"), rs.getString("face_hash"), rs.getString("card_no"), rs.getString("state"), rs.getString("last_error"), Rows.instant(rs, "synced_at"));
    }
    static ProfileRow profileRow(ResultSet rs) throws SQLException {
        return new ProfileRow(rs.getString("subject_kind"), Rows.uuid(rs, "subject_id"), rs.getString("photo"), rs.getString("card_no"), Rows.instant(rs, "consent_at"), Rows.instant(rs, "withdrawn_at"));
    }
    static TaskRow task(ResultSet rs) throws SQLException {
        return new TaskRow(Rows.uuid(rs, "id"), Rows.uuid(rs, "bridge_id"), Rows.uuid(rs, "device_id"), rs.getString("kind"), rs.getString("employee_no"), rs.getString("note"), rs.getInt("attempts"),
            Rows.instant(rs, "created_at"));
    }
    static Integer i(ResultSet rs, String c) throws SQLException { int v = rs.getInt(c); return rs.wasNull() ? null : v; }
}
