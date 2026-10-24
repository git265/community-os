package com.communityos.api.site.application.port;

import com.communityos.api.site.domain.Site;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port: the site's devices, bridges, face profiles, enrolments, the bridges' work queue and the event ledger (the caller's community). */
public interface SiteStore {
    // bridges
    List<Site.Bridge> bridges();
    Site.Bridge insertBridge(UUID id, String name, String tokenHash, String tokenHint);
    boolean revokeBridge(UUID id);
    void bridgeSeen(UUID id, String agentVersion);

    // devices
    List<Site.Device> devices();
    Optional<Site.Device> device(UUID id);
    List<Site.Device> devicesOfBridge(UUID bridgeId);
    /** secret: the sealed password, base64 (DeviceSecrets). */
    void insertDevice(UUID id, Site.DeviceFields f, String secret);
    /** A null secret keeps the stored one. Health updates move the row's version all the time, so the last edit wins. */
    boolean updateDevice(UUID id, Site.DeviceFields f, String secret);
    String secret(UUID deviceId);
    /** The community's key for device passwords (made on first use). */
    byte[] deviceKey();
    void health(Site.Health h);
    void lastEventNo(UUID deviceId, long eventNo);

    // who should be on the devices
    List<Site.Wanted> wantedPeople(LocalDate today);
    List<Site.Wanted> wantedStaff();
    /** Mark profiles whose person is no longer wanted (left_at), clear it for those wanted again, and drop staff photos kept past retention. */
    int retention(List<UUID> wantedIds, int days);

    // face profiles
    record ProfileRow(String subjectKind, UUID subjectId, String photo, String cardNo, Instant consentAt, Instant withdrawnAt) {}
    Optional<ProfileRow> profile(String kind, UUID subjectId);
    void saveProfile(String kind, UUID subjectId, String photo, boolean keepPhoto, String cardNo, Instant consentAt, UUID consentBy, String consentText, Instant withdrawnAt);
    List<Site.FaceProfile> profiles();
    /** Who carries this card number (a QR card or an M1 card), if anyone. */
    Optional<ProfileRow> profileByCard(String cardNo);
    /** The name of a staff member, if the membership is active staff. */
    Optional<String> staffName(UUID memberId);
    /** The name of a person in the gate registry. */
    Optional<String> personName(UUID personId);
    /** The face the devices get: a registry person's photo, a staff member's own (from their face profile). */
    Optional<String> facePhoto(String kind, UUID subjectId);

    // enrolments
    List<Site.Enrolment> enrolments(UUID deviceId);
    Optional<Site.Enrolment> enrolment(UUID deviceId, String employeeNo);
    void saveEnrolment(Site.Enrolment e);
    void enrolmentState(UUID deviceId, String employeeNo, String state, String error);

    // the bridges' work queue
    /** Queue a job; an open enrol / remove (for the same person) or set-time / catch-up job of the device is not queued twice. */
    void queue(UUID bridgeId, UUID deviceId, String kind, String employeeNo, String note);
    record TaskRow(UUID id, UUID bridgeId, UUID deviceId, String kind, String employeeNo, String note, int attempts, Instant createdAt) {}
    List<TaskRow> claim(UUID bridgeId, int max, int leaseSeconds);
    Optional<TaskRow> task(UUID id);
    /** What the job was sent with (an enrol job: the face it carried), to tell on completion whether the device is up to date. */
    void taskNote(UUID id, String note);
    void taskDone(UUID id, boolean ok, String error, boolean again);
    int openTasks(UUID deviceId);

    // the ledger
    /** The new row's id, or empty when the device already reported this event number. */
    Optional<UUID> insertEvent(UUID deviceId, Site.Punch p, Instant at);
    void eventOutcome(UUID id, String subjectKind, UUID subjectId, String name, String direction, String outcome, boolean counted, UUID visitId, UUID sessionId);
    record Counted(Instant at, String direction) {}
    /** The last counted punch of this person since then. */
    Optional<Counted> lastCounted(UUID subjectId, Instant since);
    List<Site.Event> events(Instant since, int limit);
    Optional<String> eventPhoto(UUID id);
}
