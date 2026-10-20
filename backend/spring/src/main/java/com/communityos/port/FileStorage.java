package com.communityos.port;

import com.communityos.domain.StoredFile;
import java.util.Optional;

/** PORT: where file BYTES live. Adapters: LocalDiskFileStorage, S3FileStorage (S3, MinIO, R2, Spaces). Azure Blob = one more class. */
public interface FileStorage {
    void put(String tenant, String id, byte[] bytes, String mime);
    Optional<StoredFile> get(String tenant, String id);
    void delete(String tenant, String id);
    String name();
}
