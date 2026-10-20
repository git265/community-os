package com.communityos.platform;

import com.communityos.finance.SystemWriter;
import com.communityos.people.Phones;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Js;
import com.communityos.service.Tx;
import com.communityos.service.audit.AuditTrail;
import com.communityos.service.audit.Stamps;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.*;
import java.util.regex.Pattern;

/**
 * The platform console's server side (backend/contract-server/platform.mjs): list the communities, create one, suspend / re-activate one.
 *
 * <p>The caller is the operator of the platform, not a member of a community: every call carries X-Platform-Key = app.platform.admin-key (16 characters or
 * more; without it the console is switched off). A new community is written in one transaction: its registry row (tenant "platform"), its starting data -
 * exactly the defaults the browser console and the Node server write (resources/rulebook/new-community.json, made by `npm run gen:new-community`) - and its
 * first Super Admin, who signs in with the phone number given here. The demo data is not offered here (it is for sandboxes on the Node server).
 */
public class PlatformService {
    public static final String WHO = "Platform admin";
    static final List<String> UNIT_TYPES = List.of("Villas and apartments", "Villas only", "Apartments only");
    static final List<String> RESERVED = List.of("platform", "www", "app", "api", "admin", "c", "static", "assets", "login");
    private static final Pattern SLUG = Pattern.compile("^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$");
    private static final Pattern EMAIL = Pattern.compile("^\\S+@\\S+\\.\\S+$");

    /** A refusal: the HTTP status, a message and, for a form, the message per field. */
    public static final class Refused extends RuntimeException {
        public final int status; public final String code; public final Map<String, String> errors;
        Refused(int status, String code, String message, Map<String, String> errors) { super(message, null, false, false); this.status = status; this.code = code; this.errors = errors; }
        static Refused form(Map<String, String> errors) { return new Refused(400, "invalid", errors.values().iterator().next(), errors); }
    }

    private final DocumentRepository repo; private final AuditTrail audit; private final ObjectMapper json; private final Clock clock; private final Tx tx; private final String key;
    private final String template;

    public PlatformService(DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, Tx tx, String adminKey) {
        this.repo = repo; this.audit = audit; this.json = json; this.clock = clock; this.tx = tx; this.key = adminKey == null ? "" : adminKey;
        try (InputStream in = PlatformService.class.getResourceAsStream("/rulebook/new-community.json")) {
            if (in == null) throw new IllegalStateException("rulebook/new-community.json is missing: run `npm run gen:new-community` in backend/contract-server");
            template = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (java.io.IOException e) { throw new IllegalStateException(e); }
    }

    public boolean enabled() { return key.length() >= 16; }

    /** The key, compared in constant time. */
    public void check(String given) {
        if (!enabled()) throw new Refused(403, "platform-off", "The platform console is switched off on this server: set app.platform.admin-key (16 characters or more).", null);
        byte[] a = (given == null ? "" : given).getBytes(StandardCharsets.UTF_8), b = key.getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(a, b)) throw new Refused(401, "platform-key", "Wrong or missing platform key.", null);
    }

    /** The registry, each with the number of people who can sign in (never their names). */
    public List<JsonNode> list() {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode c : repo.list("platform", "communities")) {
            ObjectNode o = ((ObjectNode) c).deepCopy();
            String slug = Js.str(c, "slug");
            o.put("people", slug.isEmpty() ? 0 : (int) repo.list(slug, "users").stream().filter((u) -> !Js.is(u, "status", "Inactive")).count());
            out.add(o);
        }
        out.sort(Comparator.comparing((JsonNode c) -> Js.str(c, "name")));
        return out;
    }

    /** validateNewCommunity (src/lib/platform/registry.js) + the phone the first Super Admin signs in with. */
    Map<String, String> validate(JsonNode v, List<JsonNode> existing) {
        Map<String, String> e = new LinkedHashMap<>();
        if (Js.trim(Js.orEmpty(Js.f(v, "name"))).isEmpty()) e.put("name", "Community name is required");
        String slug = Js.trim(Js.orEmpty(Js.f(v, "slug"))).toLowerCase(Locale.ROOT);
        if (slug.isEmpty()) e.put("slug", "Web address is required");
        else if (!SLUG.matcher(slug).find()) e.put("slug", "Use 3–30 letters, numbers or hyphens (no spaces)");
        else if (RESERVED.contains(slug)) e.put("slug", "That address is reserved");
        else if (existing.stream().anyMatch((c) -> Js.is(c, "slug", slug))) e.put("slug", "That web address is already taken");
        if (Js.trim(Js.orEmpty(Js.f(v, "adminName"))).isEmpty()) e.put("adminName", "First Super Admin name is required");
        if (!EMAIL.matcher(Js.trim(Js.orEmpty(Js.f(v, "adminEmail")))).find()) e.put("adminEmail", "A valid e-mail is required (it identifies the person across communities)");
        Phones.Result phone = Phones.validate(Js.str(Js.f(v, "adminPhone")));
        if (!phone.ok()) e.put("adminPhone", Js.trim(Js.str(Js.f(v, "adminPhone"))).isEmpty() ? "The first Super Admin signs in with this phone number: it is required" : phone.error());
        return e;
    }

    public JsonNode create(JsonNode v) {
        return tx.run(() -> {
            Map<String, String> errors = validate(v, repo.list("platform", "communities"));
            if (Js.truthy(v, "demoData")) errors.put("demoData", "The demo data is not loaded by this server: create the community without it.");
            if (!errors.isEmpty()) throw Refused.form(errors);
            String slug = Js.trim(Js.str(v, "slug")).toLowerCase(Locale.ROOT);
            if (!repo.list(slug, "users").isEmpty()) throw new Refused(409, "taken", "That web address already holds a community's data. Pick another address.", null);
            String name = Js.trim(Js.str(v, "name")), adminName = Js.trim(Js.str(v, "adminName"));
            Phones.Result phone = Phones.validate(Js.str(Js.f(v, "adminPhone")));
            String now = Stamps.iso(clock);
            ObjectNode community = json.createObjectNode();
            community.put("id", slug).put("slug", slug).put("name", name).put("address", Js.trim(Js.orEmpty(Js.f(v, "address"))))
                    .put("unitTypes", UNIT_TYPES.contains(Js.str(v, "unitTypes")) ? Js.str(v, "unitTypes") : UNIT_TYPES.get(0))
                    .put("status", "Active").put("demoData", false).put("createdAt", now.substring(0, 10)).put("createdBy", WHO);
            repo.upsert("platform", "communities", slug, community);
            JsonNode data = starting(name, adminName, Js.trim(Js.str(v, "adminEmail")).toLowerCase(Locale.ROOT), phone.e164(), now);
            data.fields().forEachRemaining((e) -> { List<JsonNode> rows = new ArrayList<>(); e.getValue().forEach(rows::add); if (!rows.isEmpty()) repo.upsertAll(slug, e.getKey(), rows); });
            ObjectNode a = audit.entry(SystemWriter.principal(WHO), "Communities", "communities", slug, slug, "", "Create", name + " (" + slug + ") created; first Super Admin " + adminName + " (" + phone.formatted() + ")", null);
            a.put("who", WHO).put("whoName", WHO);
            audit.write(slug, a);
            return json.createObjectNode().set("community", community);
        });
    }

    /** The template with the placeholders filled in (each value JSON-escaped, so a name with quotes stays one string). */
    JsonNode starting(String name, String adminName, String adminEmail, String adminPhone, String now) {
        String t = template.replace("__COMMUNITY_NAME__", esc(name)).replace("__ADMIN_NAME__", esc(adminName)).replace("__ADMIN_EMAIL__", esc(adminEmail))
                .replace("__ADMIN_PHONE__", esc(adminPhone)).replace("__NOW__", now);
        try { return json.readTree(t); } catch (java.io.IOException e) { throw new IllegalStateException(e); }
    }
    private String esc(String s) {
        try { String q = json.writeValueAsString(s); return q.substring(1, q.length() - 1); } catch (java.io.IOException e) { throw new IllegalStateException(e); }
    }

    public JsonNode setStatus(String slug, String status) {
        if (!"Active".equals(status) && !"Suspended".equals(status)) throw Refused.form(Map.of("status", "Status is Active or Suspended"));
        return tx.run(() -> {
            JsonNode c = repo.get("platform", "communities", slug).orElseThrow(() -> new Refused(404, "missing", "No such community.", null));
            ObjectNode out = ((ObjectNode) c).deepCopy();
            out.put("status", status);
            repo.upsert("platform", "communities", slug, out);
            ObjectNode a = audit.entry(SystemWriter.principal(WHO), "Communities", "communities", slug, slug, "", "Update", Js.str(c, "name") + ": status " + Js.str(c, "status") + " → " + status, null);
            a.put("who", WHO).put("whoName", WHO);
            audit.write(slug, a);
            return out;
        });
    }
}
