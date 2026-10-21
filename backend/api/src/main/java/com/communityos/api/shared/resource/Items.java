package com.communityos.api.shared.resource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Flat JSON of a stored resource row: the server's columns first, then the fields. */
public final class Items {
    private Items() {}
    public static JsonNode flat(ObjectMapper json, Item<?> it) {
        ObjectNode n = json.createObjectNode();
        n.put("id", it.id().toString()); n.put("shortId", it.shortId()); n.put("version", it.version());
        n.set("createdAt", json.valueToTree(it.createdAt())); n.set("updatedAt", json.valueToTree(it.updatedAt()));
        n.setAll((ObjectNode) json.valueToTree(it.data()));
        it.server().forEach((k, v) -> n.set(k, v == null ? json.nullNode() : json.valueToTree(v instanceof java.util.UUID u ? u.toString() : v)));
        return n;
    }
}
