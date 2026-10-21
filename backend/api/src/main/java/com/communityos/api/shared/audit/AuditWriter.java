package com.communityos.api.shared.audit;

import com.communityos.api.shared.security.Caller;
import java.util.List;
import java.util.UUID;

/** Port: one line in the append-only audit trail (audit.audit_event), in the same transaction as the change. Secrets are redacted by the writer. */
public interface AuditWriter {
    record Change(String field, String from, String to) {}
    enum Action { Create, Update, Delete, Denied, Export }

    void write(Caller caller, Action action, String entity, UUID entityId, String entityShortId, UUID unitId, String summary, List<Change> changes);
}
