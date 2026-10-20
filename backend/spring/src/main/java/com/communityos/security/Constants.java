package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Fixed values shared with the web app, exported from its JavaScript by backend/contract-server/test/gen-rulebook-golden.mjs. */
public record Constants(long maxBytes, Set<String> allowedExtensions, List<String> utilityTypes, List<String> builtInDocGroups, List<String> collections, Map<String, String> shortPrefixes) {

    public static Constants load(ObjectMapper json) {
        try (InputStream in = Constants.class.getResourceAsStream("/rulebook/constants.json")) {
            if (in == null) throw new IllegalStateException("rulebook/constants.json is missing: run `npm run gen:rulebook` in backend/contract-server.");
            JsonNode n = json.readTree(in);
            return new Constants(n.path("maxBytes").asLong(), Set.copyOf(strings(n.path("allowedExtensions"))), strings(n.path("utilityTypes")),
                    strings(n.path("builtInDocGroups")), strings(n.path("collections")), prefixes(n.path("shortPrefixes")));
        } catch (IOException e) {
            throw new IllegalStateException("Cannot read rulebook/constants.json", e);
        }
    }

    private static Map<String, String> prefixes(JsonNode o) { Map<String, String> m = new LinkedHashMap<>(); o.fields().forEachRemaining((e) -> m.put(e.getKey(), e.getValue().asText())); return Map.copyOf(m); }

    /** TKT, DUE, LED ...: the letters in front of a record's short number (the first three letters of the collection when it has none). */
    public String shortPrefix(String collection) { String p = shortPrefixes.get(collection); return p != null ? p : collection.substring(0, Math.min(3, collection.length())).toUpperCase(); }

    private static List<String> strings(JsonNode a) { List<String> out = new ArrayList<>(); a.forEach((x) -> out.add(x.asText())); return out; }
}
