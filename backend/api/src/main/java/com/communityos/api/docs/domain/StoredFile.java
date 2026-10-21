package com.communityos.api.docs.domain;

import java.time.Instant;
import java.util.UUID;

/** A file's metadata. The bytes are in the object store under storageKey, which never leaves the server. */
public record StoredFile(UUID id, String shortId, String fileName, String mimeType, long sizeBytes, String sha256, String ownerType, UUID ownerId, String scanStatus,
                         String visibility, UUID uploadedById, String uploadedBy, String storageKey, Instant createdAt, long version) {
    public static final String UNATTACHED = "upload";
    public boolean attached() { return !UNATTACHED.equals(ownerType); }
}
