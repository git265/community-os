package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The schemas and roles in force for a community: the built-in ones (exported from the web app's registry) overlaid with the community's own
 * rows (Studio edits and custom roles). Same merge as the Node server: stored rows win, defaults fill the rest.
 */
public final class SchemaCatalog {
    private final Map<String, Schema> schemas;
    private final Map<String, Principal.Role> roles;

    private SchemaCatalog(Map<String, Schema> schemas, Map<String, Principal.Role> roles) { this.schemas = schemas; this.roles = roles; }

    public Schema schema(String collection) { return schemas.get(collection); }
    public Principal.Role role(String roleId) { return roles.get(roleId); }
    public List<Schema> all() { return List.copyOf(schemas.values()); }

    /** Built-in data only (tests, and a community with no stored overrides). */
    public static SchemaCatalog defaults(ObjectMapper json) { return merge(json, List.of(), List.of()); }

    /** @param storedSchemas the community's `schema` rows; @param storedRoles its `roles` rows (these are the roles that exist; built-ins fill none in) */
    public static SchemaCatalog merge(ObjectMapper json, List<JsonNode> storedSchemas, List<JsonNode> storedRoles) {
        Map<String, Schema> s = new LinkedHashMap<>();
        for (JsonNode n : storedSchemas) { Schema x = Schema.parse(n); s.put(x.id(), x); }
        for (JsonNode n : builtIn(json, "default-schemas.json")) { Schema x = Schema.parse(n); s.putIfAbsent(x.id(), x); }
        Map<String, Principal.Role> r = new LinkedHashMap<>();
        List<JsonNode> roleRows = storedRoles.isEmpty() ? builtIn(json, "default-roles.json") : storedRoles;   // an empty community still has the built-in roles
        for (JsonNode n : roleRows) r.put(Js.str(n, "id"), new Principal.Role(Js.str(n, "id"), Js.str(n, "name"), Js.str(n, "category"), java.util.Set.copyOf(Js.strings(n, "permissions"))));
        return new SchemaCatalog(s, r);
    }

    private static List<JsonNode> builtIn(ObjectMapper json, String file) {
        try (InputStream in = SchemaCatalog.class.getResourceAsStream("/rulebook/" + file)) {
            if (in == null) throw new IllegalStateException("rulebook/" + file + " is missing: run `npm run gen:rulebook` in backend/contract-server.");
            List<JsonNode> out = new ArrayList<>();
            json.readTree(in).forEach(out::add);
            return out;
        } catch (IOException e) {
            throw new IllegalStateException("Cannot read rulebook/" + file, e);
        }
    }
}
