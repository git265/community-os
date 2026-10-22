package com.communityos.api.docs.application.port;

import com.communityos.api.docs.domain.StoredFile;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** File metadata (docs.file_object), explicit SQL behind it (JdbcFileRepository). */
public interface FileRepository {
    record NewFile(UUID id, String fileName, String mimeType, long sizeBytes, byte[] sha256, String storageKey, String scanStatus, String visibility) {}
    StoredFile insert(NewFile f);
    Optional<StoredFile> get(UUID id);
    /** Files attached to things of one kind (one thing when ownerId is given), newest first. */
    List<StoredFile> byOwner(String ownerType, UUID ownerId);
    boolean attach(UUID id, long version, String ownerType, UUID ownerId);
    boolean delete(UUID id, long version);
    /** A ticket comment's ticket, visibility and author (who may open a file attached to it). */
    record CommentFacts(UUID ticketId, String visibility, UUID authorId) {}
    Optional<CommentFacts> comment(UUID commentId);
    /** Files not yet scanned (the scanner was down when they came in), oldest first. */
    List<StoredFile> unscanned(int limit);
    /** The scanner's verdict on a file kept as Pending. */
    void scanned(UUID id, String status);
}
