package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/** One collection's field definitions: what each role may see (viewableBy) and edit (editableBy). Data, so the Super Admin can change it in Studio. */
public record Schema(String id, String label, List<Field> fields) {

    /** options: the choices of a select field (null when the field has none). */
    public record Field(String key, String label, String type, boolean hidden, Set<String> viewableBy, Set<String> editableBy, List<String> options) {
        public Field(String key, String label, String type, boolean hidden, Set<String> viewableBy, Set<String> editableBy) { this(key, label, type, hidden, viewableBy, editableBy, null); }
        public boolean canView(String roleId) { return viewableBy.contains(roleId); }
        public boolean canEdit(String roleId) { return editableBy.contains(roleId); }
    }

    public Optional<Field> field(String key) { return fields.stream().filter((f) -> f.key().equals(key)).findFirst(); }

    public static Schema parse(JsonNode n) {
        List<Field> fields = new ArrayList<>();
        for (JsonNode f : Js.list(n, "fields")) {
            fields.add(new Field(Js.str(f, "key"), Js.str(f, "label"), Js.str(f, "type"), Js.truthy(f, "hidden"), Set.copyOf(Js.strings(f, "viewableBy")), Set.copyOf(Js.strings(f, "editableBy")), Js.f(f, "options").isArray() ? Js.strings(f, "options") : null));
        }
        return new Schema(Js.str(n, "id"), Js.str(n, "label"), fields);
    }
}
