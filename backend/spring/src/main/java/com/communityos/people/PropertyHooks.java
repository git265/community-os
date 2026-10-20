package com.communityos.people;

import com.communityos.finance.SystemWriter;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Js;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;

import java.time.Instant;
import java.util.*;
import java.util.function.Supplier;

/**
 * The property register's server rules (src/lib/propertyServer.js), run by SecureRecordService on every single write of a property.
 *
 * <ul>
 *   <li>{@link #preWrite} BEFORE the save: every phone carries a country code and is a real number (Phones); the primary owner's phone is required, a tenant
 *       (and phone) when "Tenant occupied", a name and phone for every additional person; numbers are stored in E.164; the old secondary-owner fields are
 *       folded into the people list; one number is one person, on this property and across the community.</li>
 *   <li>{@link #postWrite} AFTER the save, in the same transaction: portal access follows the numbers on the register. A new number gets a user
 *       ("Invited") and a sign-in link by SMS and WhatsApp; a number already known gets the villa added; a number that left the property loses access to
 *       that villa (the account is deactivated when it was all they had); open invites for it are revoked. One audit line says what happened.</li>
 * </ul>
 * Messages are only queued in the notification outbox (the outbox sender delivers them when channels are enabled).
 */
public final class PropertyHooks {
    public static final String SYSTEM = "System · portal access";
    static final int INVITE_DAYS = 7;
    private static final JsonNodeFactory F = JsonNodeFactory.instance;
    private static final TextNode EMPTY = TextNode.valueOf("");
    private static final String QUEUED = "Queued — demo, not delivered";

    /** The world the after-save step writes into: the clock, ids, invite tokens and short ids. Production: {@link #env(SystemWriter, java.security.SecureRandom)}. */
    public interface Env {
        String now();
        String uuid();
        /** 24 hex characters (12 random bytes) */
        String token();
        String nextShortId(String tenant, String collection, String prefix);
    }

    public static Env env(SystemWriter w, java.security.SecureRandom random) {
        return new Env() {
            public String now() { return w.now(); }
            public String uuid() { return UUID.randomUUID().toString(); }
            public String token() { byte[] b = new byte[12]; random.nextBytes(b); return HexFormat.of().formatHex(b); }
            public String nextShortId(String tenant, String collection, String prefix) { return w.nextShortId(tenant, collection); }
        };
    }

    /** The outcome of the check before a save: a refusal, or the record to store. */
    public record Pre(String error, ObjectNode record) {}

    // ------------------------------------------------------------------------------------------------------------ before

    public static Pre preWrite(ObjectNode record, JsonNode old, List<JsonNode> properties, Supplier<String> uuid) {
        ObjectNode r = record.deepCopy();
        if (!Js.f(r, "people").isArray() && (Js.truthy(r, "secondaryOwner") || Js.truthy(old, "secondaryOwner"))) {
            ArrayNode people = F.arrayNode();
            if (Js.truthy(r, "secondaryOwner")) {
                ObjectNode p = people.addObject();
                p.put("id", uuid.get()).put("relation", "Additional owner");
                p.set("name", r.get("secondaryOwner"));
                p.set("phone", People.or(Js.f(r, "secondaryOwnerPhone"), EMPTY));
                p.put("email", "");
            }
            r.set("people", people);
        }
        r.remove("secondaryOwner"); r.remove("secondaryOwnerPhone");
        if (!Js.f(r, "people").isArray()) r.set("people", F.arrayNode());
        ArrayNode people = F.arrayNode();
        for (JsonNode x : r.get("people")) {
            if (x == null || x.isNull()) throw new IllegalArgumentException("A person on the property is empty");   // JavaScript: TypeError
            ObjectNode p = x.isObject() ? ((ObjectNode) x).deepCopy() : F.objectNode();
            if (!Js.truthy(p, "id")) p.put("id", uuid.get());
            p.put("name", Js.trim(Js.orEmpty(Js.f(x, "name"))));
            p.put("email", Js.trim(Js.orEmpty(Js.f(x, "email"))));
            people.add(p);
        }
        r.set("people", people);

        if (Js.trim(Js.orEmpty(Js.f(r, "owner"))).isEmpty()) return fail("The primary owner (on the lease / title) is required");
        if (!Js.truthy(r, "occupancy")) return fail("Say who occupies the property: owner, tenant or vacant");
        boolean tenantOccupied = Js.is(r, "occupancy", "Tenant occupied");
        boolean noTenant = Js.trim(Js.orEmpty(Js.f(r, "tenant"))).isEmpty();
        if (tenantOccupied && noTenant) return fail("A tenant name is required when the property is tenant occupied");
        if (!tenantOccupied && noTenant) { r.put("tenant", ""); r.put("tenantPhone", ""); r.put("tenantEmail", ""); }

        Map<String, JsonNode> seen = new LinkedHashMap<>();   // e164 -> name
        List<Object[]> slots = new ArrayList<>();
        slots.add(new Object[] { "Primary owner", Js.f(r, "owner"), "ownerPhone" });
        if (!Js.trim(Js.orEmpty(Js.f(r, "tenant"))).isEmpty()) slots.add(new Object[] { "Tenant", Js.f(r, "tenant"), "tenantPhone" });
        for (Object[] s : slots) {
            String out = check(seen, (String) s[0], (JsonNode) s[1], Js.f(r, (String) s[2]), true);
            if (!out.isEmpty() && !out.startsWith("+")) return fail(out);
            r.put((String) s[2], out);
        }
        for (JsonNode x : people) {
            if (!Js.truthy(x, "name")) return fail("Every additional person needs a name");
            String label = Js.truthy(x, "relation") ? Js.toStr(x.get("relation")) : "Additional person";
            String out = check(seen, label, x.get("name"), Js.f(x, "phone"), true);
            if (!out.startsWith("+")) return fail(out);
            ((ObjectNode) x).put("phone", out);
        }
        // the same number must not belong to a different person on another property
        List<JsonNode> others = new ArrayList<>();
        for (JsonNode p : properties) if (!Js.strictEq(Js.f(p, "id"), Js.f(r, "id"))) others.add(p);
        for (Map.Entry<String, JsonNode> e : seen.entrySet()) {
            for (JsonNode o : others) {
                for (ObjectNode x : People.of(o)) {
                    if (Js.truthy(x, "phone") && People.key(x.get("phone")).equals(e.getKey()) && !People.sameName(x.get("name"), e.getValue()))
                        return fail(Phones.validate(e.getKey()).formatted() + " already belongs to " + Js.toStr(x.get("name")) + " (" + Js.toStr(Js.f(o, "unit"))
                                + "). One phone number identifies one person across the community.");
                }
            }
        }
        return new Pre(null, r);
    }

    private static Pre fail(String why) { return new Pre(why, null); }

    /** "" (not required, empty) | an error | the number in E.164 */
    private static String check(Map<String, JsonNode> seen, String label, JsonNode name, JsonNode phone, boolean required) {
        if (Js.trim(Js.orEmpty(phone)).isEmpty()) return required ? label + ": phone number is required" : "";
        Phones.Result v = Phones.validate(Js.orEmpty(phone));
        if (!v.ok()) return label + " (" + (Js.truthy(name) ? Js.toStr(name) : "unnamed") + "): " + v.error();
        if (seen.containsKey(v.e164()) && !People.sameName(seen.get(v.e164()), name))
            return label + ": " + v.formatted() + " is already used for " + Js.toStr(seen.get(v.e164())) + " on this property — one number identifies one person";
        seen.put(v.e164(), name);
        return v.e164();
    }

    // ------------------------------------------------------------------------------------------------------------ after

    private static boolean isResidentRole(JsonNode id) { return id != null && id.isTextual() && (id.asText().equals("owner") || id.asText().equals("resident")); }
    private static String userPhone(JsonNode u) { return Js.truthy(u, "phone") ? People.key(u.get("phone")) : ""; }

    /** `(x || [])` of an array field; a non-array value is a TypeError in the JavaScript (it stops there, as here). */
    private static List<JsonNode> arr(JsonNode rec, String key) {
        JsonNode v = Js.f(rec, key);
        if (!Js.truthy(v)) return new ArrayList<>();
        if (!v.isArray()) throw new IllegalStateException(key + " is not a list");
        List<JsonNode> out = new ArrayList<>(); v.forEach(out::add); return out;
    }
    private static ArrayNode array(List<JsonNode> l) { ArrayNode a = F.arrayNode(); l.forEach(x -> a.add(x == null || x.isMissingNode() ? F.nullNode() : x)); return a; }
    private static boolean includes(List<JsonNode> l, JsonNode v) { for (JsonNode x : l) if (Js.strictEq(x, v)) return true; return false; }
    private static String join(List<JsonNode> l, String sep) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < l.size(); i++) { if (i > 0) b.append(sep); JsonNode x = l.get(i); if (x != null && !x.isNull() && !x.isMissingNode()) b.append(Js.toStr(x)); }
        return b.toString();
    }

    /** The person as the after-save step sees it: a peopleOf() row whose phone is the phone key. */
    private static List<ObjectNode> withPhones(JsonNode prop) {
        List<ObjectNode> out = new ArrayList<>();
        for (ObjectNode x : People.of(prop)) if (Js.truthy(x, "phone")) { ObjectNode y = x.deepCopy(); y.put("phone", People.key(x.get("phone"))); out.add(y); }
        return out;
    }

    /** One run of the after-save step (propertyPostWrite) for one community. */
    public static final class Run {
        private final DocumentRepository repo; private final AuditTrail audit; private final String tenant, slug; private final SiteProperties site; private final Env env;
        private List<JsonNode> users;

        public Run(DocumentRepository repo, AuditTrail audit, String tenant, String slug, SiteProperties site, Env env) {
            this.repo = repo; this.audit = audit; this.tenant = tenant; this.slug = slug; this.site = site; this.env = env;
        }

        private String communityName() {
            for (JsonNode m : repo.list(tenant, "mergeFields"))
                if (Js.is(m, "token", "{{SOCIETY_NAME}}")) return Js.truthy(m, "defaultValue") ? Js.toStr(m.get("defaultValue")) : "your community";
            return "your community";
        }

        private ObjectNode systemPut(String collection, String prefix, ObjectNode row) {
            String now = env.now();
            ObjectNode full = row.deepCopy();
            full.put("id", Js.truthy(row, "id") ? Js.toStr(row.get("id")) : env.uuid());
            full.put("shortId", Js.truthy(row, "shortId") ? Js.toStr(row.get("shortId")) : env.nextShortId(tenant, collection, prefix));
            full.put("recVersion", 1).put("recordCreatedAt", now).put("recordCreatedBy", SYSTEM).put("lastUpdatedAt", now).put("lastUpdatedBy", SYSTEM);
            repo.upsert(tenant, collection, full.get("id").asText(), full);
            return full;
        }

        private void saveUser(ObjectNode u) {
            repo.upsert(tenant, "users", Js.str(u, "id"), u);
            List<JsonNode> next = new ArrayList<>();
            for (JsonNode x : users) next.add(Js.strictEq(Js.f(x, "id"), Js.f(u, "id")) ? u : x);
            users = next;
        }

        private void revoke(String phone, JsonNode unit, String reason) {
            for (JsonNode i : repo.list(tenant, "portalInvites")) {
                if (Js.strictEq(Js.f(i, "phone"), TextNode.valueOf(phone)) && Js.strictEq(Js.f(i, "unit"), unit) && Js.is(i, "status", "Sent")) {
                    ObjectNode r = ((ObjectNode) i).deepCopy();
                    r.put("status", "Revoked").put("revokedReason", reason);
                    repo.upsert(tenant, "portalInvites", Js.str(r, "id"), r);
                }
            }
        }

        private void queueInvite(ObjectNode person, JsonNode unit, String community) {
            String phone = person.get("phone").asText();
            revoke(phone, unit, "Replaced by a new invite");
            String token = env.token();
            String expiresAt = Instant.parse(env.now()).plusMillis(INVITE_DAYS * 86_400_000L).toString().substring(0, 10);
            ObjectNode inv = F.objectNode();
            inv.put("token", token).put("phone", phone);
            inv.set("personName", person.get("name"));
            Js.set(inv, "unit", unit);
            inv.put("communitySlug", slug);
            Js.set(inv, "relation", person.get("relation"));
            inv.put("status", "Sent").put("expiresAt", expiresAt);
            systemPut("portalInvites", "PIV", inv);
            String link = site.communityUrl(slug) + "#/join/" + token;
            String body = "Hello " + Js.toStr(person.get("name")) + ", you have been registered for " + Js.toStr(unit) + " at " + community + ". Open " + link
                    + " to access the community portal (valid till " + expiresAt + "). If you are already on CommunityOS, this community is simply added to your account.";
            for (String channel : List.of("SMS", "WhatsApp")) {
                ObjectNode o = F.objectNode();
                o.put("event", "portal_invite").put("channel", channel).put("to", phone).put("subject", "Your community portal access").put("body", body);
                Js.set(o, "unit", unit);
                o.put("status", QUEUED).put("createdAt", env.now());
                systemPut("notificationOutbox", "OUT", o);
            }
        }

        private void queueNotice(ObjectNode person, String text, String event) {
            ObjectNode o = F.objectNode();
            o.put("event", event).put("channel", "SMS").put("to", person.get("phone").asText()).put("subject", "Portal access update").put("body", text).put("status", QUEUED).put("createdAt", env.now());
            systemPut("notificationOutbox", "OUT", o);
        }

        /** propertyPostWrite({ old, next, actor }). @return the lines of the audit entry (none: nothing changed for portal access) */
        public List<String> postWrite(JsonNode old, JsonNode next, String actor) {
            JsonNode unit = Js.f(next, "unit");
            String community = communityName();
            List<ObjectNode> before = old == null || old.isNull() ? List.of() : withPhones(old);
            List<ObjectNode> after = withPhones(next);
            Set<String> afterPhones = new HashSet<>(); after.forEach(x -> afterPhones.add(x.get("phone").asText()));
            users = new ArrayList<>(repo.list(tenant, "users"));
            List<String> events = new ArrayList<>();

            // 1) numbers that left this property (changed or removed)
            for (ObjectNode gone : before) {
                String phone = gone.get("phone").asText();
                if (afterPhones.contains(phone)) continue;
                revoke(phone, unit, "Phone number changed or person removed");
                JsonNode u = null;
                for (JsonNode x : users) if (userPhone(x).equals(phone) && !Js.is(x, "status", "Inactive")) { u = x; break; }
                if (u == null) { events.add(Js.toStr(gone.get("name")) + ": old number " + phone + " had no portal account"); continue; }
                List<JsonNode> units = new ArrayList<>();
                for (JsonNode x : arr(u, "units")) if (!Js.strictEq(x, unit)) units.add(x);
                boolean keepsOtherVilla = !units.isEmpty();
                boolean otherRole = false;
                for (JsonNode id : arr(u, "extraRoleIds")) if (!isResidentRole(id)) { otherRole = true; break; }
                ObjectNode nu = ((ObjectNode) u).deepCopy();
                nu.set("units", array(units));
                if (keepsOtherVilla || !isResidentRole(Js.f(u, "roleId")) || otherRole) {
                    saveUser(nu);
                    events.add(Js.toStr(Js.f(u, "name")) + " (" + phone + ") no longer linked to " + Js.toStr(unit)
                            + (keepsOtherVilla ? " — keeps access through " + join(units, ", ") : " — keeps their committee / staff role"));
                } else {
                    boolean owner = Js.strictEq(Js.f(next, "owner"), gone.get("name")) || Js.strictEq(Js.f(old, "owner"), gone.get("name"));
                    nu.put("status", "Inactive").put("deactivatedAt", env.now())
                            .put("deactivatedReason", "Phone number on " + Js.toStr(unit) + " was " + (owner ? "changed" : "changed or the person was removed") + " by " + actor);
                    saveUser(nu);
                    events.add("Portal access DEACTIVATED for " + Js.toStr(Js.f(u, "name")) + " (" + phone + ")");
                }
                queueNotice(gone, "Your access to " + community + " for " + Js.toStr(unit) + " has been removed because the registered phone number changed. Contact the community office if this is a mistake.",
                        "portal_access_removed");
            }

            // 2) numbers now on this property
            for (ObjectNode person : after) {
                String phone = person.get("phone").asText();
                JsonNode existing = null;
                for (JsonNode x : users) if (userPhone(x).equals(phone)) { existing = x; break; }
                boolean wasThere = false;
                for (ObjectNode x : before) if (x.get("phone").asText().equals(phone)) { wasThere = true; break; }
                boolean isOwner = person.get("isOwner").asBoolean();
                String roleId = isOwner ? "owner" : "resident";
                if (existing == null) {
                    String now = env.now();
                    ObjectNode row = F.objectNode();
                    row.put("id", env.uuid());
                    row.put("shortId", env.nextShortId(tenant, "users", "USR"));
                    row.put("recVersion", 1);
                    row.set("name", person.get("name"));
                    row.put("phone", phone);
                    row.set("email", People.or(person.get("email"), EMPTY));
                    row.put("status", "Invited").put("roleId", roleId);
                    row.set("extraRoleIds", F.arrayNode());
                    row.set("units", array(List.of(unit)));
                    row.put("portalSource", "property").put("recordCreatedAt", now).put("recordCreatedBy", SYSTEM).put("lastUpdatedAt", now).put("lastUpdatedBy", SYSTEM);
                    repo.upsert(tenant, "users", row.get("id").asText(), row);
                    users.add(row);
                    queueInvite(person, unit, community);
                    events.add("Invite sent to " + Js.toStr(person.get("name")) + " (" + phone + ") for " + Js.toStr(unit));
                    continue;
                }
                ObjectNode u = ((ObjectNode) existing).deepCopy();
                boolean reactivated = Js.is(u, "status", "Inactive");
                if (reactivated) {
                    u.put("status", "Invited").put("deactivatedAt", "").put("deactivatedReason", "");   // blanked: a store merges fields into the saved row
                    if (isResidentRole(Js.f(u, "roleId"))) u.put("roleId", roleId);
                    u.set("units", F.arrayNode());
                }
                List<JsonNode> units = arr(u, "units");
                if (!includes(units, unit)) { units.add(unit); u.set("units", array(units)); }
                if (isOwner && Js.is(u, "roleId", "resident")) u.put("roleId", "owner");
                if (!isOwner && Js.is(u, "roleId", "owner")) {
                    List<JsonNode> extra = arr(u, "extraRoleIds");
                    if (!includes(extra, TextNode.valueOf("resident"))) { extra.add(TextNode.valueOf("resident")); u.set("extraRoleIds", array(extra)); }
                }
                if (!People.sameName(Js.f(u, "name"), person.get("name")) && isResidentRole(Js.f(u, "roleId"))) u.set("name", person.get("name"));
                if (Js.truthy(person, "email") && !Js.truthy(u, "email")) u.set("email", person.get("email"));
                saveUser(u);
                if (reactivated || (!wasThere && Js.is(u, "status", "Invited"))) {
                    queueInvite(person, unit, community);
                    events.add("Invite sent to " + Js.toStr(person.get("name")) + " (" + phone + ") for " + Js.toStr(unit));
                } else if (!wasThere) {
                    queueNotice(person, Js.toStr(unit) + " has been added to your " + community + " account. Sign in with your phone number.", "portal_unit_added");
                    events.add(Js.toStr(unit) + " added to existing account of " + Js.toStr(person.get("name")));
                }
            }

            if (!events.isEmpty()) {
                String summary = String.join(" · ", events);
                if (summary.length() > 400) summary = summary.substring(0, 400);
                ObjectNode e = audit.entry(SystemWriter.principal(SYSTEM), "Portal access", "properties", Js.str(next, "id"), Js.str(next, "shortId"), Js.orEmpty(unit), "Update", summary, null);
                e.put("who", SYSTEM).put("whoName", actor);
                audit.write(tenant, e);
            }
            return events;
        }
    }

    // ------------------------------------------------------------------------------------------------------------ preview

    /** accessImpact(old, draft): the warning the property form shows before a save (what will happen to portal access). */
    public static ObjectNode accessImpact(JsonNode old, JsonNode draft) {
        List<String> lines = new ArrayList<>();
        boolean needsAck = false;
        List<ObjectNode> before = old != null && Js.truthy(old, "id") ? keyed(old) : List.of();
        List<ObjectNode> after = keyed(draft);
        Set<String> afterKeys = new HashSet<>(), beforeKeys = new HashSet<>();
        after.forEach(x -> afterKeys.add(x.get("key").asText())); before.forEach(x -> beforeKeys.add(x.get("key").asText()));
        for (ObjectNode g : before) {
            if (afterKeys.contains(g.get("key").asText())) continue;
            ObjectNode repl = null;
            for (ObjectNode x : after) if (Js.strictEq(x.get("name"), g.get("name")) && !beforeKeys.contains(x.get("key").asText())) { repl = x; break; }
            lines.add(repl != null
                    ? "⚠ " + Js.toStr(g.get("name")) + "'s number is changing from " + shown(g.get("phone")) + " to " + shown(repl.get("phone")) + ". Portal access on the old number is deactivated immediately and a new sign-in link is sent to the new number."
                    : "⚠ " + Js.toStr(g.get("name")) + " (" + shown(g.get("phone")) + ") is being removed. Their portal access to this community is deactivated immediately.");
            needsAck = true;
        }
        List<String> added = new ArrayList<>();
        for (ObjectNode x : after) {
            if (beforeKeys.contains(x.get("key").asText())) continue;
            boolean sameNameBefore = false;
            for (ObjectNode b : before) if (Js.strictEq(b.get("name"), x.get("name"))) { sameNameBefore = true; break; }
            if (!before.isEmpty() && sameNameBefore) continue;
            added.add(Js.toStr(x.get("name")) + " (" + shown(x.get("phone")) + ")");
        }
        if (!added.isEmpty()) lines.add("ℹ A sign-in link will be sent by SMS / WhatsApp to: " + String.join(", ", added) + ". If they already use another community here, this one is added to their account.");
        if (Js.is(draft, "occupancy", "Tenant occupied")) lines.add("ℹ Tenant occupied: the tenant gets portal access and communications; only owners vote in e-voting.");
        ObjectNode out = F.objectNode();
        ArrayNode l = out.putArray("lines"); lines.forEach(l::add);
        out.put("needsAck", needsAck);
        return out;
    }
    private static List<ObjectNode> keyed(JsonNode prop) {
        List<ObjectNode> out = new ArrayList<>();
        for (ObjectNode x : People.of(prop)) if (Js.truthy(x, "phone")) { ObjectNode y = x.deepCopy(); y.put("key", People.key(x.get("phone"))); out.add(y); }
        return out;
    }
    /** `validatePhone(p).formatted || p` */
    private static String shown(JsonNode phone) { Phones.Result v = Phones.validate(Js.str(phone)); return v.formatted() != null && !v.formatted().isEmpty() ? v.formatted() : Js.toStr(phone); }

    private PropertyHooks() {}
}
