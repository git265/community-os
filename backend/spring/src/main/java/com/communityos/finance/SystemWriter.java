package com.communityos.finance;

import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.security.Principal;
import com.communityos.service.audit.AuditTrail;
import com.communityos.service.audit.Stamps;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * What the background jobs write with: rows stamped like the JavaScript `stamp()` of rules.js, the next short id of a collection, and a line in
 * the audit trail under the job's own name ("System · late fees"). Everything goes straight to the repository, below the permission rules: no signed-in
 * person is involved, and a resident could not write most of these collections.
 */
public class SystemWriter {
    private final DocumentRepository repo;
    private final AuditTrail audit;
    private final ObjectMapper json;
    private final Clock clock;
    private final Constants constants;

    public SystemWriter(DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, Constants constants) {
        this.repo = repo; this.audit = audit; this.json = json; this.clock = clock; this.constants = constants;
    }

    public ObjectMapper json() { return json; }
    public Clock clock() { return clock; }
    public DocumentRepository repo() { return repo; }
    public String now() { return Stamps.iso(clock); }

    /** DUE-0123 ...: PREFIX-0001, one counter per community and collection. */
    public String nextShortId(String tenant, String collection) {
        return constants.shortPrefix(collection) + "-" + String.format("%04d", repo.nextShortNumber(tenant, collection, 0));
    }

    /** `{ id: uuid(), shortId, recVersion: 1, ...row, recordCreatedAt: now, recordCreatedBy: actor, lastUpdatedAt: now, lastUpdatedBy: actor }` */
    public ObjectNode stamp(ObjectNode row, String actor, String shortId) {
        String now = now();
        ObjectNode out = json.createObjectNode();
        out.put("id", UUID.randomUUID().toString());
        out.put("shortId", shortId);
        out.put("recVersion", 1);
        out.setAll(row);
        out.put("recordCreatedAt", now).put("recordCreatedBy", actor).put("lastUpdatedAt", now).put("lastUpdatedBy", actor);
        return out;
    }

    public static Principal principal(String actor) { return new Principal("system", new Principal.Role("system", actor, "System", Set.of()), actor, "", List.of()); }

    /** logEvent({ who, what, action, summary, unit }): the audit trail line of a job. */
    public void event(String tenant, String actor, String what, String action, String unit, String summary) {
        audit.write(tenant, audit.entry(principal(actor), what, what, "", "", unit == null ? "" : unit, action, summary, null));
    }

    public void putMany(String tenant, String collection, List<? extends JsonNode> rows) { if (!rows.isEmpty()) repo.upsertAll(tenant, collection, List.copyOf(rows)); }
}
