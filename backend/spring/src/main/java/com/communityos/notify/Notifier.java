package com.communityos.notify;

import com.communityos.amenities.IcuCompare;
import com.communityos.finance.SystemWriter;
import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.BooleanNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Tell people about something: the in-app notification (always) and a queued WhatsApp / SMS / e-mail message for each person who chose that channel when the
 * community offers it for this kind of notification. A port of notify / notifyMany / queueExtraChannels / deliverDirect / unitsWithPeople in src/lib/notify.js.
 *
 * "Queued" is all this class does: the OutboxDispatcher hands the rows to the real gateways. Both kinds of row are written in the caller's transaction, so a
 * failed save never leaves a message behind (and a failed message never undoes a save when the caller chooses to log and go on).
 */
public class Notifier {
    public static final List<String> CHANNELS = List.of("WhatsApp", "SMS", "Email");
    private static final TextNode SYSTEM = TextNode.valueOf("System");

    /** One notification. Unset fields are null; `toName` / `toUnit` / `toRoleIds` say who gets it. */
    public static final class Item {
        public String event, title, body, link, kind, by;
        public JsonNode toName, toUnit, toRoleIds;
        public ObjectNode extra;
        public List<ExtraTo> extraTo = List.of();
        public Item(String event, String title, String body) { this.event = event; this.title = title; this.body = body; }
        public Item link(String v) { link = v; return this; }
        public Item kind(String v) { kind = v; return this; }
        public Item by(String v) { by = v; return this; }
        public Item toName(JsonNode v) { toName = v; return this; }
        public Item toUnit(JsonNode v) { toUnit = v; return this; }
        public Item toRoleIds(JsonNode v) { toRoleIds = v; return this; }
        public Item extra(ObjectNode v) { extra = v; return this; }
        Item copy() { Item i = new Item(event, title, body); i.link = link; i.kind = kind; i.by = by; i.toName = toName; i.toUnit = toUnit; i.toRoleIds = toRoleIds; i.extra = extra; i.extraTo = extraTo; return i; }
    }
    public record ExtraTo(String channel, String to) {}
    public record Delivered(int inApp, int queued, int skipped) {}

    private final SystemWriter w;

    public Notifier(SystemWriter w) { this.w = w; }

    // ---- the audience ------------------------------------------------------------------------------------------------

    private JsonNode events(String tenant) {
        for (JsonNode r : w.repo().list(tenant, "notificationSettings")) if (Js.is(r, "id", "default")) return Js.f(r, "events");
        return Js.MISSING;
    }

    private static List<JsonNode> unitsOfUser(JsonNode u) {
        JsonNode units = Js.f(u, "units");
        List<JsonNode> out = new ArrayList<>();
        if (units.isArray()) { units.forEach(out::add); return out; }
        for (String x : Js.orEmpty(units).split(",", -1)) out.add(TextNode.valueOf(Js.trim(x)));
        return out;
    }

    /** Look-ups built ONCE per batch, so addressing 2,000 notifications is not 2,000 scans of every user. */
    static final class Index {
        final List<JsonNode> act = new ArrayList<>();
        final Map<JsonNode, List<JsonNode>> byName = new LinkedHashMap<>(), byUnit = new LinkedHashMap<>();
        Index(List<JsonNode> users) {
            for (JsonNode u : users) {
                if (Js.is(u, "status", "Inactive")) continue;
                act.add(u);
                byName.computeIfAbsent(Js.f(u, "name"), k -> new ArrayList<>()).add(u);
                for (JsonNode x : unitsOfUser(u)) byUnit.computeIfAbsent(x, k -> new ArrayList<>()).add(u);
            }
        }
    }

    private static boolean includes(JsonNode list, JsonNode v) { for (JsonNode e : list) if (e.equals(v) || Js.strictEq(e, v)) return true; return false; }

    static List<JsonNode> recipientsOf(Item to, Index ix) {
        Map<JsonNode, JsonNode> set = new LinkedHashMap<>();
        if (Js.truthy(to.toName)) for (JsonNode u : ix.byName.getOrDefault(to.toName, List.of())) set.put(Js.f(u, "id"), u);
        if (Js.truthy(to.toUnit)) for (JsonNode u : ix.byUnit.getOrDefault(to.toUnit, List.of())) set.put(Js.f(u, "id"), u);
        if (to.toRoleIds != null && to.toRoleIds.isArray() && to.toRoleIds.size() > 0) {
            for (JsonNode u : ix.act) {
                boolean hit = includes(to.toRoleIds, Js.f(u, "roleId"));
                JsonNode extra = Js.f(u, "extraRoleIds");
                if (!hit && extra.isArray()) for (JsonNode r : extra) if (includes(to.toRoleIds, r)) { hit = true; break; }
                if (hit) set.put(Js.f(u, "id"), u);
            }
        }
        return new ArrayList<>(set.values());
    }

    // ---- the outbox ----------------------------------------------------------------------------------------------------

    private ObjectNode outboxRow(String tenant, String channel, String event, JsonNode name, JsonNode email, JsonNode phone, String title, String body, String now) {
        JsonNode to = channel.equals("Email") ? email : phone;
        ObjectNode r = w.json().createObjectNode();
        r.put("id", UUID.randomUUID().toString());
        r.put("shortId", w.nextShortId(tenant, "notificationOutbox"));
        r.put("recVersion", 1).put("event", event).put("channel", channel);
        r.set("to", Js.truthy(to) ? to : TextNode.valueOf(""));
        Js.set(r, "toName", name);
        r.put("subject", title).put("body", "Hello " + Js.toStr(name) + ", " + body);
        r.put("status", Js.truthy(to) ? "Queued — demo, not delivered" : "Skipped — no " + (channel.equals("Email") ? "e-mail address" : "phone number"));
        r.put("createdAt", now).put("recordCreatedAt", now).put("recordCreatedBy", "System").put("lastUpdatedAt", now).put("lastUpdatedBy", "System");
        return r;
    }

    // ---- notify --------------------------------------------------------------------------------------------------------

    /** @return the number of outbox messages queued */
    public int notify(String tenant, Item item) { return notifyMany(tenant, List.of(item)); }

    /** The same for a batch (one write for the notifications, one for the outbox). */
    public int notifyMany(String tenant, List<Item> in) {
        if (in.isEmpty()) return 0;
        List<Item> items = new ArrayList<>();
        JsonNode cfg = events(tenant);
        for (Item it : in) {
            JsonNode also = Js.f(Js.f(cfg, it.event), "alsoRoles");
            if (also.isArray() && also.size() > 0) {
                Item c = it.copy();
                LinkedHashSet<JsonNode> ids = new LinkedHashSet<>();
                if (it.toRoleIds != null && Js.truthy(it.toRoleIds)) it.toRoleIds.forEach(ids::add);
                also.forEach(ids::add);
                ArrayNode a = w.json().createArrayNode(); ids.forEach(a::add);
                c.toRoleIds = a;
                items.add(c);
            } else items.add(it);
        }
        String now = w.now();
        List<ObjectNode> rows = new ArrayList<>();
        for (Item it : items) {
            ObjectNode r = w.json().createObjectNode();
            r.put("id", UUID.randomUUID().toString());
            r.put("kind", it.kind != null ? it.kind : it.event).put("event", it.event).put("title", it.title).put("body", it.body).put("link", it.link != null ? it.link : "");
            r.put("read", false).put("createdAt", now).put("by", it.by != null ? it.by : "");
            if (Js.truthy(it.toName)) r.set("toName", it.toName);
            if (Js.truthy(it.toUnit)) r.set("toUnit", it.toUnit);
            if (it.toRoleIds != null && Js.truthy(it.toRoleIds)) r.set("toRoleIds", it.toRoleIds);
            if (it.extra != null) r.setAll(it.extra);
            rows.add(r);
        }
        w.putMany(tenant, "notifications", rows);
        return queueExtraChannels(tenant, items, rows);
    }

    /** Queue WhatsApp / SMS / e-mail messages for notifications already written in-app. rows.get(i) is the in-app row of items.get(i). */
    public int queueExtraChannels(String tenant, List<Item> items, List<ObjectNode> rows) {
        JsonNode settings = events(tenant);
        Map<JsonNode, JsonNode> prefBy = new HashMap<>();
        for (JsonNode p : w.repo().list(tenant, "notificationPrefs")) prefBy.put(Js.f(p, "userName"), p);
        Index ix = new Index(w.repo().list(tenant, "users"));
        String now = w.now();
        List<ObjectNode> out = new ArrayList<>();
        for (int i = 0; i < items.size(); i++) {
            Item it = items.get(i);
            JsonNode cfg = Js.f(settings, it.event);
            List<String> offered = new ArrayList<>();
            for (String c : CHANNELS) if (!Js.truthy(cfg) || !(Js.f(cfg, c.toLowerCase()).isBoolean() && !Js.f(cfg, c.toLowerCase()).asBoolean()) ) offered.add(c);
            if (offered.isEmpty()) continue;
            for (JsonNode u : recipientsOf(it, ix)) {
                if (it.by != null && !it.by.isEmpty() && Js.strictEq(Js.f(u, "name"), TextNode.valueOf(it.by))) continue;
                JsonNode pr = prefBy.get(Js.f(u, "name"));
                if (pr == null) continue;
                for (String c : offered) if (Js.truthy(pr, c.toLowerCase()))
                    out.add(outboxRow(tenant, c, it.event, Js.f(u, "name"), Js.f(u, "email"), Js.f(u, "phone"), rows.get(i).get("title").asText(), rows.get(i).get("body").asText(), now));
            }
        }
        w.putMany(tenant, "notificationOutbox", out);
        return out.size();
    }

    /**
     * Deliver on exactly the channels given (a scheduled report states its own channels, so personal opt-in is not consulted).
     * @param channels any of "In-app", "Email", "SMS", "WhatsApp"
     */
    public Delivered deliverDirect(String tenant, List<Item> items, List<String> channels, String event) {
        int inApp = 0, queued = 0, skipped = 0;
        if (items.isEmpty()) return new Delivered(0, 0, 0);
        String now = w.now();
        if (channels.contains("In-app")) {
            List<ObjectNode> rows = new ArrayList<>();
            for (Item it : items) {
                boolean roles = it.toRoleIds != null && it.toRoleIds.isArray() && it.toRoleIds.size() > 0;
                if (!(Js.truthy(it.toName) || Js.truthy(it.toUnit) || roles)) continue;
                ObjectNode r = w.json().createObjectNode();
                r.put("id", UUID.randomUUID().toString());
                r.put("kind", event).put("event", event).put("title", it.title).put("body", it.body).put("link", it.link != null ? it.link : "").put("read", false).put("createdAt", now).put("by", it.by != null ? it.by : "");
                if (Js.truthy(it.toName)) r.set("toName", it.toName);
                if (Js.truthy(it.toUnit)) r.set("toUnit", it.toUnit);
                if (roles) r.set("toRoleIds", it.toRoleIds);
                rows.add(r);
            }
            if (!rows.isEmpty()) { w.putMany(tenant, "notifications", rows); inApp = rows.size(); }
        }
        List<String> extra = new ArrayList<>();
        for (String c : channels) if (CHANNELS.contains(c)) extra.add(c);
        if (!extra.isEmpty()) {
            Index ix = new Index(w.repo().list(tenant, "users"));
            List<ObjectNode> out = new ArrayList<>();
            for (Item it : items) {
                for (JsonNode u : recipientsOf(it, ix)) for (String c : extra) {
                    ObjectNode r = outboxRow(tenant, c, event, Js.f(u, "name"), Js.f(u, "email"), Js.f(u, "phone"), it.title, it.body, now);
                    out.add(r);
                    if (r.get("status").asText().startsWith("Queued")) queued++; else skipped++;
                }
                for (ExtraTo x : it.extraTo) if (extra.contains(x.channel())) {
                    TextNode to = TextNode.valueOf(x.to());
                    out.add(outboxRow(tenant, x.channel(), event, to, to, to, it.title, it.body, now));
                    queued++;
                }
            }
            w.putMany(tenant, "notificationOutbox", out);
        }
        return new Delivered(inApp, queued, skipped);
    }

    /** Every unit that has at least one active login (the villas a "to all villas" report can reach), in the order a person expects ("A-9" before "A-10"). */
    public List<String> unitsWithPeople(String tenant) {
        Index ix = new Index(w.repo().list(tenant, "users"));
        List<String> out = new ArrayList<>();
        for (JsonNode k : ix.byUnit.keySet()) if (Js.truthy(k)) out.add(Js.toStr(k));
        out.sort(IcuCompare::compareNumeric);
        return out;
    }
}
