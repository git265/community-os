package com.communityos.amenities;

import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.communityos.service.audit.AuditTrail;
import com.communityos.service.audit.Stamps;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Rows the SYSTEM writes on its own account (ledger lines, unit credit, queued messages, default settings): residents cannot write those collections,
 * so the booking code does it below the permission layer. Every row is stamped like any other and a ledger line also goes in the audit trail.
 */
public class AmenitySystem {
    public static final String SYSTEM = "System · amenity bookings";
    private final DocumentRepository repo;
    private final AuditTrail audit;
    private final Clock clock;
    private final Constants constants;

    public AmenitySystem(DocumentRepository repo, AuditTrail audit, Clock clock, Constants constants) { this.repo = repo; this.audit = audit; this.clock = clock; this.constants = constants; }

    static Principal principal() { return new Principal("system", new Principal.Role("system", SYSTEM, "System", Set.of()), SYSTEM, "", List.of()); }

    /** @param summary the audit line for a ledger row (its description when empty) */
    public ObjectNode put(String tenant, String collection, ObjectNode row, String summary) {
        String now = Stamps.iso(clock);
        ObjectNode full = row.deepCopy();
        String rowId = Js.truthy(row, "id") ? Js.toStr(row.get("id")) : UUID.randomUUID().toString();
        full.put("id", rowId);
        if (!Js.truthy(row, "shortId")) full.put("shortId", constants.shortPrefix(collection) + "-" + String.format("%04d", repo.nextShortNumber(tenant, collection, 0)));
        full.put("recVersion", 1).put("recordCreatedAt", now).put("recordCreatedBy", SYSTEM).put("lastUpdatedAt", now).put("lastUpdatedBy", SYSTEM);
        repo.upsert(tenant, collection, rowId, full);
        if ("ledger".equals(collection))
            audit.write(tenant, audit.entry(principal(), "Payments Cross-check", collection, rowId, full.get("shortId").asText(), "", "Create", summary != null && !summary.isEmpty() ? summary : Js.str(full, "description"), null));
        return full;
    }

    public String now() { return Stamps.iso(clock); }
    public String today() { return Stamps.iso(clock).substring(0, 10); }
    public Clock clock() { return clock; }
}
