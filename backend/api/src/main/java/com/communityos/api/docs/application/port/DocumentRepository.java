package com.communityos.api.docs.application.port;

import com.communityos.api.docs.domain.Document;
import com.communityos.api.shared.access.Spec;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** The document repository (docs.document with its file and unit), explicit SQL behind it (JdbcDocumentRepository). */
public interface DocumentRepository {
    record Filter(UUID folderId, UUID unitId, String access) {}
    List<Document> list(Spec<Document> scope, Filter f);
    Optional<Document> get(UUID id, Spec<Document> scope);
    void insert(Document d);
    boolean update(Document d);
    boolean delete(UUID id, long version);
}
