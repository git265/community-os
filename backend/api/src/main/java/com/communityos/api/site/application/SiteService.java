package com.communityos.api.site.application;

import com.communityos.api.gate.application.GateService;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.security.SystemCaller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.site.application.port.BridgeLocator;
import com.communityos.api.site.application.port.SiteStore;
import com.communityos.api.site.domain.DeviceSecrets;
import com.communityos.api.site.domain.FaceImage;
import com.communityos.api.site.domain.Site;
import com.communityos.api.workforce.application.AttendanceService;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiFunction;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The site's device layer. Administrators add bridges and devices and record face consent; the server works out who should be on which
 * device and queues the jobs; a bridge signs in with its token, takes the jobs, reports their results, the devices' health and every punch.
 * The device decides at the door on its own; the server records each punch once and turns it into a gate visit (registry people and staff)
 * and, for staff, attendance; whatever the rules would have held is flagged for the security team.
 */
public final class SiteService {
    private static final Logger log = LoggerFactory.getLogger(SiteService.class);
    public record NewBridge(Site.Bridge bridge, String token) {}
    public record Consent(boolean consent, String photo, String cardNo, String text) {}
    public record SyncResult(int enrol, int remove, int unchanged) {}
    public record BridgeDevice(UUID id, String name, String gate, String kind, String driver, String direction, List<String> capabilities, String host, Integer port,
                               boolean useTls, String username, String password, int doorNo, long lastEventNo) {}
    public record Hello(UUID bridgeId, String name, Instant serverTime, List<BridgeDevice> devices) {}
    public record Ingest(int received, int added, int counted, int flagged) {}

    static final int LEASE_SECONDS = 120, MAX_ATTEMPTS = 5, OPEN_WITHIN_SECONDS = 60, SET_TIME_AT_DRIFT = 30, MAX_PUNCHES = 500;
    /** The longest name a terminal shows (Hikvision: 32). */
    static final int NAME_MAX = 32;
    static final String TOKEN_PREFIX = "cosb_";
    static final Set<String> IN_WORDS = Set.of("in", "checkin", "breakin", "overtimein"), OUT_WORDS = Set.of("out", "checkout", "breakout", "overtimeout");

    private final SiteStore store; private final BridgeLocator locator; private final GateService gate; private final AttendanceService attendance;
    private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public SiteService(SiteStore store, BridgeLocator locator, GateService gate, AttendanceService attendance, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.locator = locator; this.gate = gate; this.attendance = attendance; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    // ---- what the security team and the administrators see -------------------------------------------------------------------------------------
    public List<Site.Device> devices(Caller c) { SitePolicy.views(c); return tx.inTx(store::devices); }
    public List<Site.Bridge> bridges(Caller c) { SitePolicy.views(c); return tx.inTx(store::bridges); }
    public List<Site.Enrolment> enrolments(Caller c, UUID deviceId) { SitePolicy.views(c); return tx.inTx(() -> store.enrolments(deviceId)); }
    public List<Site.FaceProfile> profiles(Caller c) { SitePolicy.views(c); return tx.inTx(store::profiles); }
    public List<Site.Event> events(Caller c, Instant since, Integer limit) {
        SitePolicy.views(c);
        Instant from = since != null ? since : clock.instant().minus(Duration.ofHours(24));
        int n = limit == null ? 200 : Math.max(1, Math.min(500, limit));
        return tx.inTx(() -> store.events(from, n));
    }
    public Optional<String> eventPhoto(Caller c, UUID id) { SitePolicy.views(c); return tx.inTx(() -> store.eventPhoto(id)); }
    /** One person's consent, for the registry form or a staff member's own profile. */
    public Optional<Site.FaceProfile> profile(Caller c, String kind, UUID subjectId) {
        if (!own(c, kind, subjectId)) SitePolicy.views(c);
        return tx.inTx(() -> store.profiles().stream().filter((p) -> p.subjectKind().equals(kind) && p.subjectId().equals(subjectId)).findFirst());
    }

    // ---- bridges and devices ------------------------------------------------------------------------------------------------------------------
    /** A new bridge and its token. The token is shown this once; only its hash is kept. */
    public NewBridge createBridge(Caller c, String name) {
        SitePolicy.manages(c);
        String n = blank(name);
        if (n == null || n.length() > 80) throw new DomainException.RuleViolated("name", "Name the bridge (up to 80 characters)");
        String token = TOKEN_PREFIX + Crypto.randomToken(32);
        return tx.inTx(() -> {
            Site.Bridge b = store.insertBridge(UUID.randomUUID(), n, tokenHash(token), token.substring(token.length() - 4));
            audit.write(c, AuditWriter.Action.Create, "gate.bridge", b.id(), b.shortId(), null, "Added site bridge " + n, List.of());
            return new NewBridge(b, token);
        });
    }
    public void revokeBridge(Caller c, UUID id) {
        SitePolicy.manages(c);
        tx.run(() -> {
            Site.Bridge b = store.bridges().stream().filter((x) -> x.id().equals(id)).findFirst().orElseThrow(() -> new DomainException.NotFound("Bridge"));
            if (!store.revokeBridge(id)) throw new DomainException.RuleViolated("revoked", b.name() + " is revoked already");
            audit.write(c, AuditWriter.Action.Update, "gate.bridge", b.id(), b.shortId(), null, "Revoked site bridge " + b.name() + ": its token no longer signs in", List.of());
        });
    }
    /** Add (id null) or change a device; then put the right people on it. A blank password keeps the stored one. */
    public Site.Device saveDevice(Caller c, UUID id, Site.DeviceFields f) {
        SitePolicy.manages(c);
        Site.DeviceFields v = valid(f);
        Site.Device d = tx.inTx(() -> {
            boolean isNew = id == null; UUID did = isNew ? UUID.randomUUID() : id;
            Optional<Site.Device> was = isNew ? Optional.empty() : store.device(did);
            if (!isNew && was.isEmpty()) throw new DomainException.NotFound("Device");
            if (v.bridgeId() != null && store.bridges().stream().noneMatch((b) -> b.id().equals(v.bridgeId()) && "Active".equals(b.status())))
                throw new DomainException.RuleViolated("bridge", "Choose an active site bridge");
            String pw = blank(v.password());
            if ("hikvision-isapi".equals(v.driver()) && pw == null && (isNew || !was.get().hasPassword()))
                throw new DomainException.RuleViolated("password-required", "Enter the device's admin password");
            String secret = pw == null ? null : Base64.getEncoder().encodeToString(DeviceSecrets.seal(store.deviceKey(), did, pw));
            if (isNew) store.insertDevice(did, v, secret);
            else if (!store.updateDevice(did, v, secret)) throw new DomainException.NotFound("Device");
            Site.Device saved = store.device(did).orElseThrow(() -> new DomainException.NotFound("Device"));
            audit.write(c, isNew ? AuditWriter.Action.Create : AuditWriter.Action.Update, "gate.device", saved.id(), saved.shortId(), null,
                (isNew ? "Added " : "Changed ") + saved.kind().toLowerCase() + " " + saved.name() + " at " + saved.gate() + (pw != null && !isNew ? " (new password)" : ""), List.of());
            return saved;
        });
        if ("Active".equals(d.status())) sync(c, d.id(), false);
        return d;
    }
    /** Open a device's door from the screen: queued for its bridge (sent only within a minute), always flagged. */
    public void openDoor(Caller c, UUID deviceId, String reason) {
        SitePolicy.door(c);
        String why = blank(reason);
        if (why == null) throw new DomainException.RuleViolated("reason-required", "Say why the door is opened from the screen");
        tx.run(() -> {
            Site.Device d = store.device(deviceId).orElseThrow(() -> new DomainException.NotFound("Device"));
            if (!d.capabilities().contains("Relay") || d.bridgeId() == null) throw new DomainException.RuleViolated("no-relay", d.name() + " cannot open a door from here");
            if (!"Active".equals(d.status())) throw new DomainException.RuleViolated("paused", d.name() + " is paused");
            store.queue(d.bridgeId(), d.id(), "open", null, cut(why, 200));
            gate.raiseFlag(c, "Manual open", c.displayName(), d.gate(), "The door of " + d.name() + " was opened from the screen by " + c.displayName() + ": " + why, null);
            audit.write(c, AuditWriter.Action.Update, "gate.device", d.id(), d.shortId(), null, "Opened the door of " + d.name() + " from the screen: " + why, List.of());
        });
    }
    /** Send everyone to this device again (after a reset, or to retry the ones that failed). */
    public SyncResult resync(Caller c, UUID deviceId) {
        SitePolicy.manages(c);
        Site.Device d = tx.inTx(() -> store.device(deviceId)).orElseThrow(() -> new DomainException.NotFound("Device"));
        SyncResult r = sync(c, d.id(), true);
        tx.run(() -> audit.write(c, AuditWriter.Action.Update, "gate.device", d.id(), d.shortId(), null, "Resent everyone to " + d.name() + " (" + r.enrol() + " to put on, " + r.remove() + " to take off)", List.of()));
        return r;
    }
    /** Work out who should be on every device and queue the difference (the job runs this; an administrator can too). */
    public SyncResult sync(Caller c) { if (c.category() != Caller.Category.System) SitePolicy.manages(c); return sync(c, null, false); }

    /**
     * Vetted registry people with consent who work for a unit or are on an active roster, and staff with consent and their own photo, go on
     * every active device that holds faces or cards; anyone else on a device comes off. A failed enrolment waits for new data or a resync.
     */
    private SyncResult sync(Caller c, UUID only, boolean force) {
        return tx.inTx(() -> {
            LocalDate today = LocalDate.now(clock);
            Set<UUID> bridges = store.bridges().stream().filter((b) -> "Active".equals(b.status())).map(Site.Bridge::id).collect(Collectors.toSet());
            List<Site.Device> devices = store.devices().stream()
                .filter((d) -> (only == null || d.id().equals(only)) && "Active".equals(d.status()) && d.bridgeId() != null && bridges.contains(d.bridgeId()) && d.canHold()).toList();
            List<Site.Wanted> wanted = new ArrayList<>(store.wantedPeople(today));
            wanted.addAll(store.wantedStaff());
            if (only == null) store.retention(wanted.stream().map(Site.Wanted::subjectId).toList(), Site.FACE_RETENTION_DAYS);
            int enrol = 0, remove = 0, unchanged = 0;
            for (Site.Device d : devices) {
                Map<String, Site.Enrolment> have = new HashMap<>();
                for (Site.Enrolment e : store.enrolments(d.id())) have.put(e.employeeNo(), e);
                for (Site.Wanted w : wanted) {
                    if (w.cardNo() == null && !d.capabilities().contains("Face")) continue;   // nothing this device could check
                    Site.Enrolment e = have.remove(w.employeeNo());
                    String hash = FaceImage.hash(w.photo()), name = cut(w.name(), NAME_MAX);
                    boolean on = e != null && Set.of("Enrolled", "Pending enrol", "Failed").contains(e.state());
                    boolean same = on && Objects.equals(e.name(), name) && Objects.equals(e.validTo(), w.validTo()) && Objects.equals(e.faceHash(), hash) && Objects.equals(e.cardNo(), w.cardNo());
                    if (same && !force) { unchanged++; continue; }
                    LocalDate from = on && e.validFrom() != null ? e.validFrom() : w.validFrom();
                    store.saveEnrolment(new Site.Enrolment(d.id(), w.employeeNo(), w.subjectKind(), w.subjectId(), name, from, w.validTo(), hash, w.cardNo(), "Pending enrol", null, null));
                    store.queue(d.bridgeId(), d.id(), "enrol", w.employeeNo(), null);
                    enrol++;
                }
                for (Site.Enrolment e : have.values()) {
                    if ("Removed".equals(e.state()) || ("Pending removal".equals(e.state()) && !force)) continue;
                    store.enrolmentState(d.id(), e.employeeNo(), "Pending removal", null);
                    store.queue(d.bridgeId(), d.id(), "remove", e.employeeNo(), null);
                    remove++;
                }
            }
            return new SyncResult(enrol, remove, unchanged);
        });
    }

    // ---- face consent ---------------------------------------------------------------------------------------------------------------------------
    /**
     * Record (or withdraw) someone's consent to be on the devices, their card number, and for a staff member their own face photo (a registry
     * person's face is their registry photo). Withdrawing deletes a staff member's photo at once and takes them off every device.
     */
    public Optional<Site.FaceProfile> saveProfile(Caller c, String kind, UUID subjectId, Consent k) {
        if (!"person".equals(kind) && !"member".equals(kind)) throw new DomainException.RuleViolated("kind", "Consent is for a registry person or a staff member");
        if (!own(c, kind, subjectId)) SitePolicy.records(c);
        String photo = blank(k.photo()), card = blank(k.cardNo()), text = blank(k.text());
        if (photo != null) {
            if (!"member".equals(kind)) throw new DomainException.RuleViolated("photo", "A registry person's face is their registry photo: change it there");
            if (!k.consent()) throw new DomainException.RuleViolated("consent", "Record consent before adding a face photo");
            byte[] b = FaceImage.bytes(photo);
            if (b == null) throw new DomainException.RuleViolated("photo", "The face photo must be a JPEG or PNG");
            if (b.length > 300_000) throw new DomainException.RuleViolated("photo-size", "The face photo must be under 300 KB");
            if (FaceImage.forDevice(photo) == null) throw new DomainException.RuleViolated("photo", "This photo cannot be used on the terminals (too small, or not a photo)");
        }
        if (card != null && !card.matches("[0-9]{4,20}")) throw new DomainException.RuleViolated("card", "A card number is 4 to 20 digits");
        if (text != null && text.length() > 2000) throw new DomainException.RuleViolated("text", "The consent wording is up to 2000 characters");
        tx.run(() -> {
            String name = ("member".equals(kind) ? store.staffName(subjectId) : store.personName(subjectId))
                .orElseThrow(() -> new DomainException.NotFound("member".equals(kind) ? "Staff member" : "Person"));
            if (card != null) store.profileByCard(card).filter((o) -> !o.subjectId().equals(subjectId))
                .ifPresent((o) -> { throw new DomainException.RuleViolated("card-taken", "Card " + card + " is given to someone else already"); });
            Optional<SiteStore.ProfileRow> was = store.profile(kind, subjectId);
            boolean had = was.isPresent() && was.get().consentAt() != null && was.get().withdrawnAt() == null;
            Instant now = clock.instant();
            UUID by = c.membership() == null ? null : c.membership().value();
            if (k.consent()) store.saveProfile(kind, subjectId, photo, photo == null, card, had ? was.get().consentAt() : now, by, text != null ? text : Site.CONSENT_TEXT, null);
            else store.saveProfile(kind, subjectId, null, false, card, was.map(SiteStore.ProfileRow::consentAt).orElse(null), by, null, had ? now : was.map(SiteStore.ProfileRow::withdrawnAt).orElse(null));
            String what = k.consent() ? (had ? "face consent kept" : "face consent recorded") + (photo != null ? ", new face photo" : "") : had ? "face consent withdrawn" : "no face consent";
            audit.write(c, AuditWriter.Action.Update, "gate.face_profile", subjectId, null, null, name + ": " + what + (card != null ? ", card " + card : ""), List.of());
        });
        sync(c, null, false);
        return tx.inTx(() -> store.profiles().stream().filter((p) -> p.subjectKind().equals(kind) && p.subjectId().equals(subjectId)).findFirst());
    }

    // ---- the bridge ---------------------------------------------------------------------------------------------------------------------------
    /** Sign the bridge in by its token and do the work as the system of its community (with the gate desk's permission). */
    public <T> T asBridge(String token, String agent, BiFunction<Caller, UUID, T> work) {
        String t = blank(token);
        if (t == null || !t.startsWith(TOKEN_PREFIX) || t.length() > 100) throw new AccessDenied("Unknown site bridge");
        BridgeLocator.Located b = locator.byTokenHash(tokenHash(t)).filter((x) -> "Active".equals(x.status())).orElseThrow(() -> new AccessDenied("Unknown or revoked site bridge"));
        Caller system = SystemCaller.of(b.community(), "bridge " + b.name(), Permission.MANAGE_SECURITY);
        return CallerHolder.runAs(system, () -> {
            tx.run(() -> store.bridgeSeen(b.bridge(), agent == null ? null : cut(agent, 40)));
            return work.apply(system, b.bridge());
        });
    }
    /** What the bridge needs to reach its devices (their passwords, opened only for it) and where each one's events stopped. */
    public Hello hello(Caller c, UUID bridgeId) {
        SitePolicy.bridge(c);
        return tx.inTx(() -> {
            byte[] key = store.deviceKey();
            List<BridgeDevice> ds = new ArrayList<>();
            for (Site.Device d : store.devicesOfBridge(bridgeId)) {
                String sealed = store.secret(d.id());
                String pw = null;
                try { pw = sealed == null ? null : DeviceSecrets.open(key, d.id(), Base64.getDecoder().decode(sealed)); }
                catch (RuntimeException e) { log.warn("password of device {} does not open: {}", d.id(), e.toString()); }
                ds.add(new BridgeDevice(d.id(), d.name(), d.gate(), d.kind(), d.driver(), d.direction(), d.capabilities(), d.host(), d.port(), d.useTls(), d.username(), pw, d.doorNo(), d.lastEventNo()));
            }
            String name = store.bridges().stream().filter((b) -> b.id().equals(bridgeId)).map(Site.Bridge::name).findFirst().orElse(null);
            return new Hello(bridgeId, name, clock.instant(), ds);
        });
    }
    /** The bridge's next jobs (claimed for two minutes). An enrol job carries the face as a small JPEG; a door is opened only within a minute. */
    public List<Site.Task> tasks(Caller c, UUID bridgeId, Integer max) {
        SitePolicy.bridge(c);
        int n = max == null ? 10 : Math.max(1, Math.min(20, max));
        return tx.inTx(() -> {
            Instant now = clock.instant();
            Map<UUID, Site.Device> devices = new HashMap<>();
            for (Site.Device d : store.devicesOfBridge(bridgeId)) devices.put(d.id(), d);
            List<Site.Task> out = new ArrayList<>();
            for (SiteStore.TaskRow t : store.claim(bridgeId, n, LEASE_SECONDS)) {
                Site.Device d = devices.get(t.deviceId());
                if (d == null) { store.taskDone(t.id(), false, "The device is paused or no longer on this bridge", false); continue; }
                switch (t.kind()) {
                    case "open" -> {
                        if (t.createdAt() != null && t.createdAt().isBefore(now.minusSeconds(OPEN_WITHIN_SECONDS))) { store.taskDone(t.id(), false, "Too late to open", false); continue; }
                        out.add(new Site.Task(t.id(), d.id(), "open", null, t.note(), t.attempts(), null, null, null, null, null));
                    }
                    case "enrol" -> {
                        Optional<Site.Enrolment> e = store.enrolment(d.id(), t.employeeNo());
                        if (e.isEmpty() || !"Pending enrol".equals(e.get().state())) { store.taskDone(t.id(), true, "Nothing to do", false); continue; }
                        Site.Enrolment x = e.get();
                        String face = d.capabilities().contains("Face") ? store.facePhoto(x.subjectKind(), x.subjectId()).map(FaceImage::forDevice).orElse(null) : null;
                        if (face == null && (x.cardNo() == null || d.capabilities().contains("Face") && !d.capabilities().contains("Card"))) {
                            store.taskDone(t.id(), false, "No usable face photo", false);
                            store.enrolmentState(d.id(), x.employeeNo(), "Failed", "No usable face photo: a JPEG or PNG photo of the face is needed");
                            continue;
                        }
                        store.taskNote(t.id(), signature(x));
                        out.add(new Site.Task(t.id(), d.id(), "enrol", x.employeeNo(), face == null && d.capabilities().contains("Face") ? "Card only: no usable face photo" : null, t.attempts(),
                            x.name(), x.validFrom(), x.validTo(), x.cardNo(), face));
                    }
                    case "remove" -> {
                        Optional<Site.Enrolment> e = store.enrolment(d.id(), t.employeeNo());
                        if (e.isPresent() && "Pending enrol".equals(e.get().state())) { store.taskDone(t.id(), true, "Wanted again", false); continue; }
                        out.add(new Site.Task(t.id(), d.id(), "remove", t.employeeNo(), null, t.attempts(), null, null, null, null, null));
                    }
                    case "set-time" -> out.add(new Site.Task(t.id(), d.id(), "set-time", null, now.toString(), t.attempts(), null, null, null, null, null));
                    case "catch-up" -> out.add(new Site.Task(t.id(), d.id(), "catch-up", null, t.note(), t.attempts(), null, null, null, null, null));
                    default -> store.taskDone(t.id(), false, "Unknown job", false);
                }
            }
            return out;
        });
    }
    /** How a job went. A failed enrol or removal is tried again (up to five times) unless the bridge says it cannot work. */
    public void taskResult(Caller c, UUID bridgeId, UUID taskId, boolean ok, String error, boolean permanent) {
        SitePolicy.bridge(c);
        tx.run(() -> {
            SiteStore.TaskRow t = store.task(taskId).filter((x) -> x.bridgeId().equals(bridgeId)).orElseThrow(() -> new DomainException.NotFound("Job"));
            String err = ok ? null : cut(blank(error) == null ? "Failed" : error.strip(), 300);
            boolean again = !ok && !permanent && t.attempts() < MAX_ATTEMPTS && Set.of("enrol", "remove").contains(t.kind());
            store.taskDone(t.id(), ok, err, again);
            if (t.employeeNo() == null) return;
            Optional<Site.Enrolment> e = store.enrolment(t.deviceId(), t.employeeNo());
            if ("enrol".equals(t.kind()) && e.isPresent() && "Pending enrol".equals(e.get().state())) {
                if (ok && signature(e.get()).equals(t.note())) store.enrolmentState(t.deviceId(), t.employeeNo(), "Enrolled", null);
                else if (ok) store.queue(t.bridgeId(), t.deviceId(), "enrol", t.employeeNo(), null);   // it changed while it was being sent: send again
                else if (!again) store.enrolmentState(t.deviceId(), t.employeeNo(), "Failed", err);
            } else if ("remove".equals(t.kind()) && e.isPresent() && "Pending removal".equals(e.get().state())) {
                if (ok) store.enrolmentState(t.deviceId(), t.employeeNo(), "Removed", null);
                else if (!again) store.enrolmentState(t.deviceId(), t.employeeNo(), "Failed", cut("Could not take off the device: " + err, 300));
            }
        });
    }
    /** What the bridge sees of its devices. A clock off by more than half a minute is set right. */
    public void health(Caller c, UUID bridgeId, List<Site.Health> list) {
        SitePolicy.bridge(c);
        tx.run(() -> {
            Set<UUID> mine = store.devicesOfBridge(bridgeId).stream().map(Site.Device::id).collect(Collectors.toSet());
            for (Site.Health h : list == null ? List.<Site.Health>of() : list) {
                if (h == null || !mine.contains(h.deviceId())) continue;
                store.health(new Site.Health(h.deviceId(), h.online(), cut(h.serial(), 60), cut(h.model(), 60), cut(h.firmware(), 60), h.clockDriftS(), h.enrolledCount(), cut(h.lastError(), 300)));
                if (h.online() && h.clockDriftS() != null && Math.abs(h.clockDriftS()) > SET_TIME_AT_DRIFT) store.queue(bridgeId, h.deviceId(), "set-time", null, null);
            }
        });
    }

    /**
     * The device's punches. Each is kept once (the device's own event number); an allowed punch of someone known becomes their gate visit (and
     * a staff member's attendance) at the device's time; a second punch within two minutes is kept but not counted; someone the platform does
     * not know is flagged. A punch the platform cannot apply is kept with the reason, never lost.
     */
    public Ingest events(Caller c, UUID bridgeId, UUID deviceId, List<Site.Punch> punches) {
        SitePolicy.bridge(c);
        Site.Device d = tx.inTx(() -> store.device(deviceId)).filter((x) -> bridgeId.equals(x.bridgeId())).orElseThrow(() -> new DomainException.NotFound("Device"));
        List<Site.Punch> sorted = (punches == null ? List.<Site.Punch>of() : punches).stream().filter(Objects::nonNull).sorted(Comparator.comparingLong(Site.Punch::eventNo)).limit(MAX_PUNCHES).toList();
        int added = 0, counted = 0, flagged = 0; long top = d.lastEventNo();
        Instant now = clock.instant();
        for (Site.Punch raw : sorted) {
            if (raw.eventNo() < 0) continue;
            Site.Punch p = clean(raw);
            Instant at = when(d, p.at(), now);
            top = Math.max(top, p.eventNo());
            Optional<UUID> id = tx.inTx(() -> store.insertEvent(d.id(), p, at));
            if (id.isEmpty()) continue;   // reported before
            added++;
            Effect r;
            try { r = tx.inTx(() -> apply(c, d, p, at)); }
            catch (RuntimeException e) {
                log.warn("punch {} of device {} not applied: {}", p.eventNo(), d.id(), e.toString());
                r = new Effect(null, null, null, null, "Not recorded: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()), false, null, null, false);
            }
            Effect fr = r;
            tx.run(() -> store.eventOutcome(id.get(), fr.kind(), fr.subjectId(), fr.name(), fr.direction(), cut(fr.outcome(), 300), fr.counted(), fr.visitId(), fr.sessionId()));
            if (r.counted()) counted++;
            if (r.flagged()) flagged++;
        }
        long last = top;
        if (last > d.lastEventNo()) tx.run(() -> store.lastEventNo(d.id(), last));
        return new Ingest(punches == null ? 0 : punches.size(), added, counted, flagged);
    }

    record Who(String kind, UUID id, String name) {}
    record Effect(String kind, UUID subjectId, String name, String direction, String outcome, boolean counted, UUID visitId, UUID sessionId, boolean flagged) {}
    private Effect apply(Caller c, Site.Device d, Site.Punch p, Instant at) {
        Who who = whoIs(d, p);
        String kind = who == null ? null : who.kind(); UUID sid = who == null ? null : who.id(); String name = who == null ? null : who.name();
        if (!"Allowed".equals(p.result())) return new Effect(kind, sid, name, null, "Refused by the device" + (p.reason() == null ? "" : ": " + p.reason()), false, null, null, false);
        if (who == null) {
            gate.raiseFlag(c, "Device entry", "Unknown person", d.gate(), d.name() + " let in someone CommunityOS does not know (" + p.credential().toLowerCase()
                + (p.employeeNo() == null ? "" : ", device user " + p.employeeNo()) + (p.cardNo() == null ? "" : ", card " + p.cardNo()) + "). Check the device's own user list.", p.photo());
            return new Effect(null, null, null, null, "Unknown person: flagged", false, null, null, true);
        }
        Optional<SiteStore.Counted> last = store.lastCounted(who.id(), at.minusSeconds(Site.DOUBLE_TAP_SECONDS));
        if (last.isPresent() && Math.abs(Duration.between(last.get().at(), at).getSeconds()) <= Site.DOUBLE_TAP_SECONDS)
            return new Effect(kind, sid, name, last.get().direction(), "Double tap: not counted", false, null, null, false);
        String said = p.attendanceStatus() == null ? "" : p.attendanceStatus().toLowerCase().replaceAll("[^a-z]", "");
        boolean in = switch (d.direction()) {
            case "In" -> true;
            case "Out" -> false;
            default -> IN_WORDS.contains(said) || (!OUT_WORDS.contains(said) && !gate.inside(who.kind(), who.id()));
        };
        String dir = in ? "In" : "Out", how = p.credential() + " · " + d.name();
        if ("person".equals(who.kind())) {
            GateService.Outcome o = in ? gate.deviceIn(c, who.id(), d.gate(), how, at) : gate.deviceOut(c, who.id(), d.gate(), how, at);
            boolean flag = in && o.reason() != null;
            return new Effect(kind, sid, name, dir, dir + (o.reason() == null ? "" : (flag ? " · flagged: " : " · ") + o.reason()), true, o.visit() == null ? null : o.visit().id, null, flag);
        }
        GateService.Outcome o = gate.staffAtGate(c, who.id(), d.gate(), in, how, at);
        AttendanceService.DevicePunch a = attendance.devicePunch(c, who.id(), who.name(), in, at, d.name());
        return new Effect(kind, sid, name, dir, dir + " · " + a.outcome(), true, o.visit() == null ? null : o.visit().id, a.sessionId(), false);
    }
    /** Whose punch: the device's user number is the person's id; a card is looked up among the cards given out. */
    private Who whoIs(Site.Device d, Site.Punch p) {
        if (p.employeeNo() != null) {
            Optional<Site.Enrolment> e = store.enrolment(d.id(), p.employeeNo());
            if (e.isPresent()) return new Who(e.get().subjectKind(), e.get().subjectId(), nameOf(e.get().subjectKind(), e.get().subjectId()).orElse(e.get().name()));
        }
        if (p.cardNo() != null) {
            Optional<SiteStore.ProfileRow> r = store.profileByCard(p.cardNo());
            if (r.isPresent()) { Optional<String> n = nameOf(r.get().subjectKind(), r.get().subjectId()); if (n.isPresent()) return new Who(r.get().subjectKind(), r.get().subjectId(), n.get()); }
        }
        return null;
    }
    private Optional<String> nameOf(String kind, UUID id) { return "member".equals(kind) ? store.staffName(id) : store.personName(id); }

    // ---- helpers -----------------------------------------------------------------------------------------------------------------------------
    /** The event's time: the device's, set right when its clock is known to be far off, never in the future. */
    static Instant when(Site.Device d, Instant at, Instant now) {
        if (at == null) return now;
        Instant t = d.clockDriftS() != null && Math.abs(d.clockDriftS()) > Site.TRUSTED_DRIFT_SECONDS ? at.minusSeconds(d.clockDriftS()) : at;
        return t.isAfter(now.plusSeconds(120)) ? now : t;
    }
    static Site.Punch clean(Site.Punch p) {
        String cred = p.credential() != null && Site.CREDENTIALS.contains(p.credential()) ? p.credential() : "Other";
        String photo = p.photo() != null && p.photo().startsWith("data:image/jpeg;base64,") && p.photo().length() <= 400_000 ? p.photo() : null;
        String raw = p.raw() != null && p.raw().length() <= 8000 ? p.raw() : null;
        String emp = blank(p.employeeNo());
        return new Site.Punch(p.eventNo(), p.at(), cred, emp == null ? null : cut(emp.toLowerCase(), 40), cut(blank(p.cardNo()), 40), "Allowed".equals(p.result()) ? "Allowed" : "Refused",
            cut(blank(p.reason()), 200), cut(blank(p.attendanceStatus()), 20), photo, raw);
    }
    /** What an enrolment sent to the device was: a change while the job was out means it is sent again. */
    static String signature(Site.Enrolment e) { return HexFormat.of().formatHex(Crypto.sha256(e.name() + "|" + e.validTo() + "|" + e.faceHash() + "|" + e.cardNo()), 0, 12); }
    static String tokenHash(String token) { return HexFormat.of().formatHex(Crypto.sha256(token)); }
    private static boolean own(Caller c, String kind, UUID subjectId) { return "member".equals(kind) && c.membership() != null && c.membership().value().equals(subjectId); }
    static Site.DeviceFields valid(Site.DeviceFields f) {
        if (f == null) throw new DomainException.RuleViolated("device", "Describe the device");
        String name = blank(f.name());
        if (name == null || name.length() > 80) throw new DomainException.RuleViolated("name", "Name the device (up to 80 characters)");
        String gateName = blank(f.gate()) == null ? "Main gate" : cut(f.gate().strip(), 60);
        if (!Site.KINDS.contains(f.kind())) throw new DomainException.RuleViolated("kind", "Choose what the device is: " + String.join(", ", Site.KINDS));
        if (!Site.DRIVERS.contains(f.driver())) throw new DomainException.RuleViolated("driver", "Choose how the device is reached: " + String.join(", ", Site.DRIVERS));
        String direction = blank(f.direction()) == null ? "In" : f.direction();
        if (!Site.DIRECTIONS.contains(direction)) throw new DomainException.RuleViolated("direction", "A device counts In, Out or Both");
        List<String> caps = f.capabilities() == null || f.capabilities().isEmpty() ? ("Face terminal".equals(f.kind()) ? List.of("Face", "Card", "QR", "Relay") : List.of()) : List.copyOf(f.capabilities());
        for (String x : caps) if (!Site.CAPABILITIES.contains(x)) throw new DomainException.RuleViolated("capabilities", "Unknown capability: " + x);
        boolean isapi = "hikvision-isapi".equals(f.driver());
        String host = blank(f.host());
        if (isapi && (f.bridgeId() == null || host == null)) throw new DomainException.RuleViolated("connection", "Choose the site bridge and enter the device's address");
        if (host != null && !host.matches("[A-Za-z0-9.:\\-\\[\\]]{1,100}")) throw new DomainException.RuleViolated("host", "The device's address is an IP address or a host name");
        boolean tls = Boolean.TRUE.equals(f.useTls());
        Integer port = f.port() != null ? f.port() : isapi ? (tls ? 443 : 80) : null;
        if (port != null && (port < 1 || port > 65535)) throw new DomainException.RuleViolated("port", "The port is 1 to 65535");
        int door = f.doorNo() == null ? 1 : f.doorNo();
        if (door < 1 || door > 8) throw new DomainException.RuleViolated("door", "The door number is 1 to 8");
        if (f.capacity() != null && (f.capacity() < 1 || f.capacity() > 1_000_000)) throw new DomainException.RuleViolated("capacity", "The capacity is 1 to 1,000,000");
        String status = blank(f.status()) == null ? "Active" : f.status();
        if (!Set.of("Active", "Paused").contains(status)) throw new DomainException.RuleViolated("status", "A device is Active or Paused");
        String user = blank(f.username()) == null ? (isapi ? "admin" : null) : cut(f.username().strip(), 64);
        String pw = f.password() == null || f.password().isBlank() ? null : f.password();
        if (pw != null && pw.length() > 64) throw new DomainException.RuleViolated("password", "The password is up to 64 characters");
        return new Site.DeviceFields(name, gateName, f.kind(), cut(blank(f.make()), 60), cut(blank(f.model()), 60), f.driver(), direction, caps, f.bridgeId(), host, port, tls, user, pw, door, f.capacity(), status);
    }
    static String blank(String s) { return s == null || s.isBlank() ? null : s.strip(); }
    static String cut(String s, int n) { return s == null || s.length() <= n ? s : s.substring(0, n); }
}
