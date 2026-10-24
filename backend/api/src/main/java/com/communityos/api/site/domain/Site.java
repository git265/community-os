package com.communityos.api.site.domain;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * The site's device layer: every entry device (face / QR / PIN terminal now; ANPR, FASTag and the phone kiosk later) reports through one
 * ledger, and the server decides who is on which device. A device is reached by a site bridge (the CommunityOS agent at the gate) that
 * talks the device's own protocol on the community network and connects out to the server.
 */
public final class Site {
    private Site() {}
    public static final List<String> KINDS = List.of("Face terminal", "QR reader", "ANPR camera", "FASTag reader", "Barrier", "Phone kiosk");
    public static final List<String> DRIVERS = List.of("hikvision-isapi", "app-kiosk");
    public static final List<String> DIRECTIONS = List.of("In", "Out", "Both");
    public static final List<String> CAPABILITIES = List.of("Face", "Card", "QR", "PIN", "Fingerprint", "Plate", "Tag", "Relay");
    public static final List<String> CREDENTIALS = List.of("Face", "Card", "QR", "PIN", "Fingerprint", "Plate", "Tag", "App", "Other");
    /** A second punch by the same person within this many seconds is kept in the ledger but not counted. */
    public static final int DOUBLE_TAP_SECONDS = 120;
    /** A device clock this far from the server's is not trusted for an event's time. */
    public static final int TRUSTED_DRIFT_SECONDS = 600;
    /** Face photos of people who left are deleted after this many days. */
    public static final int FACE_RETENTION_DAYS = 30;
    public static final String CONSENT_TEXT = "I agree that my face photo is used only to let me in and out of the community and to record my attendance. "
        + "It is kept safely, never shared, and deleted when I stop working here.";

    /** A site bridge: what it calls itself, whether it may still sign in, when it was last heard from. */
    public record Bridge(UUID id, String shortId, String name, String status, String tokenHint, Instant lastSeenAt, String agentVersion, Instant createdAt) {}

    /** A device as the server keeps it (the password never leaves the server except to its own bridge). */
    public record Device(UUID id, String shortId, String name, String gate, String kind, String make, String model, String driver, String direction,
                         List<String> capabilities, UUID bridgeId, String host, Integer port, boolean useTls, String username, boolean hasPassword,
                         int doorNo, Integer capacity, String status, String serial, String firmware, boolean online, Instant lastSeenAt,
                         Integer clockDriftS, Integer enrolledCount, String lastError, long lastEventNo, long version) {
        public boolean canHold() { return capabilities.contains("Face") || capabilities.contains("Card"); }
    }

    /** The fields an administrator writes. A blank password keeps the stored one. */
    public record DeviceFields(String name, String gate, String kind, String make, String model, String driver, String direction, List<String> capabilities,
                               UUID bridgeId, String host, Integer port, Boolean useTls, String username, String password, Integer doorNo, Integer capacity, String status) {}

    /** Someone who should be on the devices: a vetted registry person or a staff member, with what the device needs. */
    public record Wanted(String subjectKind, UUID subjectId, String name, LocalDate validFrom, LocalDate validTo, String photo, String cardNo) {
        public String employeeNo() { return subjectId.toString().replace("-", ""); }
    }
    /** Who is on a device (or about to be put on or taken off). */
    public record Enrolment(UUID deviceId, String employeeNo, String subjectKind, UUID subjectId, String name, LocalDate validFrom, LocalDate validTo,
                            String faceHash, String cardNo, String state, String lastError, Instant syncedAt) {}

    /** One job for a bridge. An enrol job carries what the device needs (the face as a small JPEG). */
    public record Task(UUID id, UUID deviceId, String kind, String employeeNo, String note, int attempts, String name, LocalDate validFrom, LocalDate validTo,
                       String cardNo, String faceJpegBase64) {}

    /** A punch as the bridge reports it (the device's own words turned into these). */
    public record Punch(long eventNo, Instant at, String credential, String employeeNo, String cardNo, String result, String reason, String attendanceStatus,
                        String photo, String raw) {}
    /** A punch in the ledger, with what the platform made of it. */
    public record Event(UUID id, UUID deviceId, String deviceName, String gate, long eventNo, Instant at, Instant receivedAt, String credential, String subjectKind,
                        UUID subjectId, String name, String direction, String result, String reason, String outcome, boolean counted, UUID visitId, UUID sessionId,
                        boolean hasPhoto) {}

    /** What the bridge says about a device. */
    public record Health(UUID deviceId, boolean online, String serial, String model, String firmware, Integer clockDriftS, Integer enrolledCount, String lastError) {}

    /** The consent (and a staff member's own face photo) for being put on the devices. */
    public record FaceProfile(String subjectKind, UUID subjectId, String name, boolean hasPhoto, String cardNo, Instant consentAt, String consentText, Instant withdrawnAt,
                              String onDevices) {}
}
