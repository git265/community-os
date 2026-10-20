package com.communityos.access;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.security.access.AccessDeniedException;

/** A write the rules refused (403). Carries the audit line to keep: it is written AFTER the transaction rolls back, so the refusal is never lost. */
public class AuthzDeniedException extends AccessDeniedException {
    private final transient ObjectNode auditEntry;
    public AuthzDeniedException(String reason, ObjectNode auditEntry) { super(reason); this.auditEntry = auditEntry; }
    /** The entry for the audit trail, or null when none should be kept (a refusal that is itself not audited). */
    public ObjectNode auditEntry() { return auditEntry; }
}
