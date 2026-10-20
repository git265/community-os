package com.communityos.people;

import com.communityos.notify.Notifier;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;

import java.util.List;
import java.util.Map;

/**
 * Meetings (src/lib/meetingServer.js): who sees them and who is told.
 * <ul>
 *   <li>"Internal (committee only)": only the committee and management see it; nobody is told.</li>
 *   <li>"Published to residents" (also any meeting without the setting, from before it existed): owners and residents see it and are told - in the app
 *       and on the channels each person chose - when it is first published, when the date, time, place, title or status changes, when it is cancelled,
 *       and when minutes are added.</li>
 * </ul>
 */
public final class MeetingHooks {
    public static final String INTERNAL = "Internal (committee only)";
    public static final String PUBLISHED = "Published to residents";
    private static final List<String> WATCH = List.of("date", "startTime", "endTime", "location", "status", "title");
    private static final Map<String, String> HEAD = Map.of("published", "New meeting", "updated", "Meeting updated", "cancelled", "Meeting cancelled", "minutes", "Minutes available");

    public static boolean isPublished(JsonNode m) { return m != null && !m.isNull() && !m.isMissingNode() && !Js.is(m, "visibility", INTERNAL); }

    /** meetingPreWrite: the moment it was first published (kept), '' while internal. */
    public static ObjectNode preWrite(ObjectNode record, JsonNode old, String now) {
        ObjectNode r = record.deepCopy();
        if (isPublished(r)) {
            JsonNode was = Js.f(old, "publishedAt");
            if (Js.truthy(was)) r.set("publishedAt", was);
            else r.put("publishedAt", Js.is(r, "visibility", PUBLISHED) ? now : "");
        } else r.put("publishedAt", "");
        return r;
    }

    /** The message meetingPostWrite sends, or null when nobody is to be told. */
    public static Notifier.Item message(JsonNode old, JsonNode next, String actor, JsonNode toRoleIds) {
        if (!isPublished(next)) return null;
        boolean hadOld = old != null && !old.isNull() && !old.isMissingNode();
        boolean wasPublished = hadOld && isPublished(old) && Js.truthy(old, "publishedAt");
        if (Js.is(next, "status", "Cancelled") && Js.is(old, "status", "Cancelled")) return null;   // already told
        String kind = null;
        if (!wasPublished) kind = "published";
        else if (WATCH.stream().anyMatch(k -> Js.differs(Js.f(next, k), Js.f(old, k)))) kind = Js.is(next, "status", "Cancelled") && !Js.is(old, "status", "Cancelled") ? "cancelled" : "updated";
        else if (Js.truthy(next, "minutes") && !Js.truthy(old, "minutes")) kind = "minutes";
        if (kind == null) return null;
        String title = Js.toStr(Js.f(next, "title")), date = Js.toStr(Js.f(next, "date"));
        String when = Js.orEmpty(Js.f(next, "date")) + (Js.truthy(next, "startTime") ? " at " + Js.toStr(next.get("startTime")) : "");
        String place = Js.truthy(next, "location") ? " · " + Js.toStr(next.get("location")) : "";
        String text = switch (kind) {
            case "published" -> title + " (" + Js.toStr(Js.f(next, "committee")) + ") is scheduled for " + when + place + ". The agenda is in Governance.";
            case "updated" -> title + " is now " + when + place + ".";
            case "cancelled" -> title + " on " + date + " has been cancelled.";
            default -> "Minutes of " + title + " (" + date + ") are now available in Governance.";
        };
        return new Notifier.Item("meeting", HEAD.get(kind) + " · " + title, text).kind("meeting").link("#/governance").by(actor == null ? "" : actor).toRoleIds(toRoleIds);
    }

    /** residentRoleIds(): the roles of the Resident category, or owner + resident when the community has none. */
    public static ArrayNode residentRoleIds(DocumentRepository repo, String tenant) {
        ArrayNode ids = JsonNodeFactory.instance.arrayNode();
        for (JsonNode r : repo.list(tenant, "roles")) if (Js.is(r, "category", "Resident")) ids.add(Js.f(r, "id").isMissingNode() ? JsonNodeFactory.instance.nullNode() : r.get("id"));
        if (ids.isEmpty()) { ids.add(TextNode.valueOf("owner")); ids.add(TextNode.valueOf("resident")); }
        return ids;
    }

    /** meetingPostWrite: tell residents. @return true when a message went out */
    public static boolean postWrite(Notifier notifier, DocumentRepository repo, String tenant, JsonNode old, JsonNode next, String actor) {
        if (!isPublished(next)) return false;
        Notifier.Item m = message(old, next, actor, null);
        if (m == null) return false;
        m.toRoleIds(residentRoleIds(repo, tenant));
        notifier.notify(tenant, m);
        return true;
    }

    private MeetingHooks() {}
}
