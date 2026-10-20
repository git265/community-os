package com.communityos.service.audit;

import com.communityos.port.DocumentRepository;
import com.communityos.security.Principal;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Writes the audit trail. Only the server writes it (the audit collection refuses every other writer), one line for every create, update,
 * delete and refusal, with who, from where (ip) and which request (requestId). Numbers (AUD-00042) come from a database sequence.
 */
@Component
public class AuditTrail {
    public static final String COLLECTION = "audit";
    /** Collections whose changes are not audited: conversation (forum, comments, poll answers) and raw file bytes (the owning record carries the audit). */
    private static final Set<String> NOT_AUDITED = Set.of("forum", "forumPosts", "files", "vendorComments", "ballotBox", "pollVotes", "audit");

    private final DocumentRepository repo;
    private final ObjectMapper json;
    private final java.time.Clock clock;

    public AuditTrail(DocumentRepository repo, ObjectMapper json, java.time.Clock clock) { this.repo = repo; this.json = json; this.clock = clock; }

    /** Fields whose values never go into the audit trail, anywhere (a password, a card, an ID number ...): the same words as guards.mjs. */
    static final Pattern SENSITIVE_FIELD = Pattern.compile("(pass(word)?|pwd|secret|token|otp|pin|cvv|cvc|card|aadhaar|ssn|account(number|no)|bankaccount|pan(number)?|authorization|signature)", Pattern.CASE_INSENSITIVE);
    private Set<String> secretFields = Set.of();   // the fields the community chose to encrypt: hidden here too

    @Autowired(required = false)
    public void setFieldCrypto(com.communityos.crypto.FieldCrypto crypto) { this.secretFields = crypto.fields(); }

    /** A change to a secret field says THAT it changed, not to what: from / to become "[hidden]" (an empty or missing side stays as it is). */
    public static ArrayNode redactChanges(JsonNode changes, Set<String> extra) {
        ArrayNode out = JsonNodeFactory.instance.arrayNode();
        if (changes == null || !changes.isArray()) return out;
        for (JsonNode c : changes) {
            String name = com.communityos.security.Js.truthy(c, "field") ? com.communityos.security.Js.toStr(c.get("field")) : com.communityos.security.Js.orEmpty(com.communityos.security.Js.f(c, "label"));
            JsonNode field = com.communityos.security.Js.f(c, "field");
            boolean secret = SENSITIVE_FIELD.matcher(name).find() || (field.isTextual() && extra.contains(field.asText()));
            if (!secret || !c.isObject()) { out.add(c); continue; }
            ObjectNode r = ((ObjectNode) c).deepCopy();
            for (String side : new String[] {"from", "to"}) {
                JsonNode v = c.get(side);
                if (v != null && !(v.isTextual() && v.asText().isEmpty()) && !v.isNull()) r.put(side, "[hidden]");
            }
            out.add(r);
        }
        return out;
    }

    public static boolean audited(String collection) { return !NOT_AUDITED.contains(collection); }

    /** The entry for one change, not yet written. */
    public ObjectNode entry(Principal p, String what, String collection, JsonNode record, String action, String summary, ArrayNode changes) {
        return entry(p, what, collection, record == null ? "" : text(record, "id"), record == null ? "" : text(record, "shortId"), unitOf(record), action, summary, changes);
    }

    public ObjectNode entry(Principal p, String what, String collection, String recordId, String recordShortId, String unit, String action, String summary, ArrayNode changes) {
        ObjectNode e = json.createObjectNode();
        e.put("who", p.label()).put("whoName", p.name()).put("what", what).put("collection", collection).put("recordId", recordId == null ? "" : recordId)
                .put("recordShortId", recordShortId == null ? "" : recordShortId).put("unit", unit == null ? "" : unit).put("action", action).put("summary", summary == null ? "" : summary);
        e.set("changes", changes == null ? json.createArrayNode() : changes);
        return e;
    }

    /** Numbers, dates and request details are added here; the row goes into the audit collection. */
    public ObjectNode write(String tenant, ObjectNode entry) {
        ObjectNode row = json.createObjectNode();
        row.put("id", UUID.randomUUID().toString());
        row.put("shortId", String.format("AUD-%05d", repo.nextAuditNumber()));
        row.put("when", Stamps.iso(clock));
        row.set("changes", json.createArrayNode());
        row.setAll(entry);
        row.set("changes", redactChanges(entry.get("changes"), secretFields));
        String ip = MDC.get("clientIp"); String rid = MDC.get("requestId");
        if (ip != null && !ip.isEmpty()) row.put("ip", ip);
        if (rid != null && !rid.isEmpty()) row.put("requestId", rid);
        repo.upsert(tenant, COLLECTION, row.get("id").asText(), row);
        return row;
    }

    private static String text(JsonNode r, String k) { JsonNode v = r.get(k); return v == null || v.isNull() ? "" : v.asText(""); }

    /** unit || hostUnit || '' */
    private static String unitOf(JsonNode r) {
        if (r == null) return "";
        String u = text(r, "unit");
        return !u.isEmpty() ? u : text(r, "hostUnit");
    }
}
