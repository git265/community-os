package com.communityos.people;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.BooleanNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Who is attached to a property (src/lib/people.js): the primary owner, an optional tenant, additional owners / tenants / contacts. */
public final class People {
    private static final JsonNodeFactory F = JsonNodeFactory.instance;
    private static final TextNode EMPTY = TextNode.valueOf("");

    public static boolean isOwnerRelation(JsonNode r) { return Js.strictEq(r, TextNode.valueOf("Additional owner")); }

    /** `x || fallback` */
    static JsonNode or(JsonNode x, JsonNode fallback) { return Js.truthy(x) ? x : fallback; }

    /** peopleOf(prop): {slot, name, phone, email, relation, isOwner} for every person on the property, in order. */
    public static List<ObjectNode> of(JsonNode prop) {
        List<ObjectNode> out = new ArrayList<>();
        if (prop == null || prop.isMissingNode() || prop.isNull()) return out;
        if (Js.truthy(prop, "owner")) out.add(person("primary", Js.f(prop, "owner"), Js.f(prop, "ownerPhone"), Js.f(prop, "ownerEmail"), TextNode.valueOf("Primary owner"), true));
        if (Js.truthy(prop, "tenant")) out.add(person("tenant", Js.f(prop, "tenant"), Js.f(prop, "tenantPhone"), Js.f(prop, "tenantEmail"), TextNode.valueOf("Tenant"), false));
        JsonNode extra = Js.f(prop, "people");
        int n = extra.isArray() ? extra.size() : 0;
        for (int i = 0; i < n; i++) {
            JsonNode x = extra.get(i);
            if (!Js.truthy(x, "name")) continue;
            JsonNode slot = Js.truthy(x, "id") ? Js.f(x, "id") : TextNode.valueOf("p:" + Js.toStr(Js.f(x, "name")));
            JsonNode relation = or(Js.f(x, "relation"), TextNode.valueOf("Additional owner"));
            ObjectNode p = person(null, Js.f(x, "name"), Js.f(x, "phone"), Js.f(x, "email"), relation, isOwnerRelation(relation));
            p.set("slot", slot);
            out.add(p);
        }
        if (n == 0 && Js.truthy(prop, "secondaryOwner"))
            out.add(person("secondary", Js.f(prop, "secondaryOwner"), Js.f(prop, "secondaryOwnerPhone"), EMPTY, TextNode.valueOf("Additional owner"), true));
        return out;
    }

    private static ObjectNode person(String slot, JsonNode name, JsonNode phone, JsonNode email, JsonNode relation, boolean owner) {
        ObjectNode p = F.objectNode();
        if (slot != null) p.put("slot", slot);
        p.set("name", name);
        p.set("phone", or(phone, EMPTY));
        p.set("email", or(email, EMPTY));
        p.set("relation", relation);
        p.set("isOwner", BooleanNode.valueOf(owner));
        return p;
    }

    /** sameName(a, b): equal after trimming, ignoring case. */
    public static boolean sameName(JsonNode a, JsonNode b) { return lower(a).equals(lower(b)); }
    private static String lower(JsonNode v) { return Js.trim(Js.orEmpty(v)).toLowerCase(Locale.ROOT); }

    /** phoneKey(x) of a stored value: `String(x ?? '')` first. */
    public static String key(JsonNode phone) { return Phones.key(Js.str(phone)); }

    private People() {}
}
