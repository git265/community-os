package com.communityos.api.docs.application.port;

/** Where file bytes live (a local folder in development; S3 / Azure Blob in production). Keys are made by the server. */
public interface FileStorage {
    void put(String key, byte[] bytes);
    byte[] get(String key);
    void delete(String key);
}
