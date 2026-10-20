package com.communityos.amenities;

import com.communityos.port.DocumentRepository;
import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The messages a booking sends: for each enabled template of the event, one queued row per recipient (the owner, the admins) in the outbox, and the
 * in-app bell. A port of amenityNotify / queue / sendReport in src/lib/amenityServer.js.
 *
 * "Queued" is all this class does: OutboxDispatcher hands the rows to the e-mail / SMS / WhatsApp adapters (app.channels.enabled). A row with no phone
 * or address is stored as "Skipped - no contact". Every row goes in the same transaction as the booking that caused it.
 */
public class AmenityNotifier {
    private final DocumentRepository repo;
    private final AmenitySystem system;
    private final ObjectMapper json;

    public AmenityNotifier(DocumentRepository repo, AmenitySystem system, ObjectMapper json) { this.repo = repo; this.system = system; this.json = json; }

    AmenitySystem system() { return system; }

    private static void put(ObjectNode o, String k, JsonNode v) { if (v != null && !v.isMissingNode()) o.set(k, v); }
    private static JsonNode f(JsonNode r, String k) { return Js.f(r, k); }

    // ---- who and what --------------------------------------------------------------------------------------------------

    /** The name of the community, from the merge field {{SOCIETY_NAME}}. */
    String communityName(String tenant) {
        for (JsonNode m : repo.list(tenant, "mergeFields")) if (Js.is(m, "token", "{{SOCIETY_NAME}}")) { String v = Js.orEmpty(f(m, "defaultValue")); return v.isEmpty() ? "Community" : v; }
        return "Community";
    }

    record Owner(JsonNode name, JsonNode email, JsonNode phone) {}

    /** `(x.units || []).includes(unit)`: an array holds the unit, a text contains it. */
    private static boolean includes(JsonNode units, JsonNode unit) {
        if (!Js.truthy(units)) return false;
        if (units.isArray()) { for (JsonNode e : units) if (Js.strictEq(e, unit)) return true; return false; }
        return units.isTextual() && units.asText().contains(Js.toStr(unit));
    }

    /** The resident of the unit (a signed-in user who holds it), else the owner on the property record. */
    Owner ownerOf(String tenant, JsonNode unit) {
        JsonNode empty = json.getNodeFactory().textNode("");
        for (JsonNode u : repo.list(tenant, "users"))
            if (!Js.is(u, "status", "Inactive") && includes(f(u, "units"), unit))
                return new Owner(f(u, "name"), Js.truthy(u, "email") ? f(u, "email") : empty, Js.truthy(u, "phone") ? f(u, "phone") : empty);
        for (JsonNode p : repo.list(tenant, "properties"))
            if (Js.strictEq(f(p, "unit"), unit)) return new Owner(Js.truthy(p, "owner") ? f(p, "owner") : empty, empty, Js.truthy(p, "ownerPhone") ? f(p, "ownerPhone") : empty);
        return new Owner(empty, empty, empty);
    }

    private List<JsonNode> templates(String tenant, String event) {
        return repo.list(tenant, "notificationTemplates").stream().filter(t -> Js.is(t, "event", event) && !isFalse(f(t, "enabled"))).toList();
    }
    private static boolean isFalse(JsonNode n) { return n != null && n.isBoolean() && !n.asBoolean(); }

    // ---- the outbox ----------------------------------------------------------------------------------------------------

    private static final Pattern LOOKS_HTML = Pattern.compile("<\\/?[a-z][\\s\\S]*?>", Pattern.CASE_INSENSITIVE);
    private static final Pattern TAG = Pattern.compile("<[^>]*>");

    /** The readable text of a rich-text body. (The JavaScript used the browser's parser; this cuts the tags and decodes the usual entities.) */
    static String htmlToText(String html) {
        String s = TAG.matcher(html).replaceAll("");
        s = s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
        return Js.trim(s.replace(' ', ' '));
    }

    /** Queue one outbox row. A real gateway (SMTP / SMS / WhatsApp Business API) replaces `status` with the delivery receipt, see OutboxDispatcher. */
    ObjectNode queue(String tenant, ObjectNode row0) {
        ObjectNode row = row0.deepCopy();
        String body = Js.orEmpty(f(row0, "body"));
        if (LOOKS_HTML.matcher(body).find()) {   // rich-text (HTML) e-mail bodies: the outbox keeps the readable text and the formatted version separately
            row.put("body", htmlToText(body));
            if (Js.is(row0, "channel", "Email")) row.put("html", body);
        }
        row.put("status", Js.truthy(row0, "to") ? "Queued — demo, not delivered" : "Skipped — no contact");
        row.put("createdAt", system.now());
        return system.put(tenant, "notificationOutbox", row, null);
    }

    private ObjectNode outRow(String event, JsonNode channel, String audience, JsonNode to, JsonNode toLabel, String subject, String body) {
        ObjectNode r = json.createObjectNode();
        r.put("event", event); put(r, "channel", channel); r.put("audience", audience); put(r, "to", to); put(r, "toLabel", toLabel); r.put("subject", subject); r.put("body", body);
        return r;
    }

    // ---- one booking event ---------------------------------------------------------------------------------------------

    /**
     * @param settings the amenity settings row (who is told, which channels)
     * @param reason   text for the {{reason}} token ('' = the booking's own cancel reason)
     * @param extra    token values that win over the booking's own (null for none)
     */
    public void notify(String tenant, String event, JsonNode booking, JsonNode settings, String reason, Map<String, String> extra) {
        String name = communityName(tenant);
        Owner owner = ownerOf(tenant, f(booking, "unit"));
        Map<String, String> vars = AmenityTemplates.bookingVars(booking, name, AmenityTemplates.val(owner.name()), reason, extra);
        JsonNode adminsNode = f(settings, "adminRecipients");
        for (JsonNode t : templates(tenant, event)) {
            String subject = AmenityTemplates.render(f(t, "subject"), vars), body = AmenityTemplates.render(f(t, "body"), vars);
            if (Js.is(t, "audience", "Owner") && !isFalse(f(settings, "notifyOwner"))) {
                ObjectNode r = outRow(event, f(t, "channel"), "Owner", Js.is(t, "channel", "Email") ? owner.email() : owner.phone(), Js.truthy(owner.name()) ? owner.name() : f(booking, "unit"), subject, body);
                put(r, "bookingId", f(booking, "id")); put(r, "bookingNo", f(booking, "shortId")); put(r, "unit", f(booking, "unit"));
                queue(tenant, r);
            }
            if (Js.is(t, "audience", "Admin") && !isFalse(f(settings, "notifyAdmin")) && adminsNode.isArray()) {
                for (JsonNode a : adminsNode) {
                    if (!Js.strictEq(f(a, "channel"), f(t, "channel")) || !Js.truthy(a, "target")) continue;
                    ObjectNode r = outRow(event, f(t, "channel"), "Admin", f(a, "target"), Js.truthy(a, "label") ? f(a, "label") : f(a, "target"), subject, body);
                    put(r, "bookingId", f(booking, "id")); put(r, "bookingNo", f(booking, "shortId")); put(r, "unit", f(booking, "unit"));
                    queue(tenant, r);
                }
            }
        }
        // the in-app bell: the villa (owner-facing events) and amenity managers
        String title = AmenityTemplates.BELL_TITLES.get(event);
        if (title != null) {
            ObjectNode base = json.createObjectNode();
            base.put("kind", "amenity"); base.put("ticketNumber", ""); base.put("link", "#/amenities/" + Js.toStr(f(booking, "shortId"))); base.put("read", false); base.put("createdAt", system.now());
            base.put("title", title + " · " + Js.toStr(f(booking, "shortId"))); base.put("body", Js.toStr(f(booking, "amenity")) + " · " + Js.toStr(f(booking, "date")) + " · " + Js.toStr(f(booking, "slot")));
            if (AmenityTemplates.BOOKING_EVENTS.contains(event)) bell(tenant, base, "toUnit", f(booking, "unit"));
            JsonNode roles = f(settings, "inAppRoleIds");
            if (!Js.truthy(roles)) { ArrayNode d = json.createArrayNode(); d.add("facility_manager").add("committee_amenities"); roles = d; }
            bell(tenant, base, "toRoleIds", roles);
        }
    }

    private void bell(String tenant, ObjectNode base, String key, JsonNode to) {
        ObjectNode n = base.deepCopy();
        n.put("id", UUID.randomUUID().toString());
        put(n, key, to);
        repo.upsert(tenant, "notifications", n.get("id").asText(), n);
    }

    // ---- the reports ---------------------------------------------------------------------------------------------------

    public record Sent(AmenityReports.Report report, int queued, String from, String to) {}

    public Sent sendReport(String tenant, String kind, ZoneId zone) { return sendReport(tenant, kind, null, null, zone); }

    /** Queue the daily or summary report for every report recipient, in the channels that have an enabled template. */
    public Sent sendReport(String tenant, String kind, String fromOrNull, String toOrNull, ZoneId zone) {
        JsonNode settings = repo.list(tenant, "amenitySettings").stream().findFirst().orElse(json.createObjectNode());
        List<JsonNode> bookings = repo.list(tenant, "amenities");
        String name = communityName(tenant);
        String t0 = system.today();
        boolean daily = "daily".equals(kind);
        String from = daily ? t0 : fromOrNull != null && !fromOrNull.isEmpty() ? fromOrNull : AmenityReports.addDays(t0, -(Js.is(settings, "summaryReport", "Monthly") ? 30 : 7), zone);
        String to = daily ? t0 : toOrNull != null && !toOrNull.isEmpty() ? toOrNull : t0;
        AmenityReports.Report report = AmenityReports.build(kind, bookings, name, from, to, t0, zone);
        String event = daily ? "daily_report" : "summary_report";
        JsonNode recips = f(settings, "reportRecipients");
        int n = 0;
        for (JsonNode t : templates(tenant, event)) {
            Map<String, String> vars = new java.util.LinkedHashMap<>();
            vars.put("community", name); vars.put("report", report.text()); vars.put("report_period", daily ? t0 : from + " to " + to); vars.put("gstin", "");
            String subject = AmenityTemplates.render(f(t, "subject"), vars), body = AmenityTemplates.render(f(t, "body"), vars);
            if (!recips.isArray()) continue;
            for (JsonNode r : recips) {
                if (!Js.strictEq(f(r, "channel"), f(t, "channel")) || !Js.truthy(r, "target")) continue;
                ObjectNode row = outRow(event, f(t, "channel"), "Admin", f(r, "target"), Js.truthy(r, "label") ? f(r, "label") : f(r, "target"), subject, body);
                row.put("reportKind", kind);
                queue(tenant, row);
                n++;
            }
        }
        return new Sent(report, n, from, to);
    }
}
