package com.communityos.api.shared.custom;

import com.communityos.api.shared.domain.DomainException;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * The `custom` jsonb of a row ("typed columns + JSONB extras"): only keys a committee defined for that entity in config.field_definition are
 * accepted, each value must have the defined type, and a member without one of the field's edit roles cannot change it. Unknown keys are refused
 * (not silently dropped) so a typo shows up at once. Values are capped (2 000 characters, 50 keys) so the column cannot be used as a blob store.
 */
public final class CustomFields {
    public record Definition(String key, String type, boolean required, List<String> options, Set<UUID> editRoles) {}
    /** Port: the custom-field definitions of one entity in the caller's community (cached briefly). */
    public interface Definitions { List<Definition> of(String entity); }

    private static final int MAX_KEYS = 50, MAX_TEXT = 2000;
    private final Definitions definitions;
    public CustomFields(Definitions definitions) { this.definitions = definitions; }

    /** The merged custom map after applying `changes` (null value = remove the key) to `current`. */
    public Map<String, Object> apply(String entity, Map<String, Object> current, Map<String, Object> changes, Set<UUID> callerRoleIds) {
        if (changes == null || changes.isEmpty()) return current;
        Map<String, Definition> defs = new LinkedHashMap<>();
        for (Definition d : definitions.of(entity)) defs.put(d.key(), d);
        Map<String, Object> out = new LinkedHashMap<>(current);
        for (Map.Entry<String, Object> e : changes.entrySet()) {
            Definition d = defs.get(e.getKey());
            if (d == null) throw new DomainException.RuleViolated("unknown-field", "There is no field \"" + e.getKey() + "\" on " + entity);
            if (!d.editRoles().isEmpty() && d.editRoles().stream().noneMatch(callerRoleIds::contains))
                throw new DomainException.RuleViolated("field-locked", "You cannot change \"" + d.key() + "\"");
            if (e.getValue() == null) { if (d.required()) throw required(d); out.remove(d.key()); continue; }
            out.put(d.key(), check(d, e.getValue()));
        }
        if (out.size() > MAX_KEYS) throw new DomainException.RuleViolated("too-many-fields", "Too many extra fields");
        for (Definition d : defs.values()) if (d.required() && !out.containsKey(d.key())) throw required(d);
        return out;
    }

    private static DomainException required(Definition d) { return new DomainException.RuleViolated("field-required", "\"" + d.key() + "\" is required"); }

    private static Object check(Definition d, Object v) {
        String bad = "\"" + d.key() + "\" must be a " + d.type();
        switch (d.type()) {
            case "text", "textarea", "richtext", "phone", "email", "time", "lookup" -> {
                if (!(v instanceof String s) || s.length() > MAX_TEXT) throw new DomainException.RuleViolated("field-type", bad);
                if (d.type().equals("email") && !s.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+")) throw new DomainException.RuleViolated("field-type", bad);
                if (d.type().equals("phone") && !s.matches("\\+?[0-9 -]{6,20}")) throw new DomainException.RuleViolated("field-type", bad);
                return s;
            }
            case "number", "money" -> {
                if (v instanceof Number n) return new BigDecimal(n.toString());
                if (v instanceof String s && s.matches("-?[0-9]{1,12}(\\.[0-9]{1,4})?")) return new BigDecimal(s);
                throw new DomainException.RuleViolated("field-type", bad);
            }
            case "boolean" -> { if (v instanceof Boolean b) return b; throw new DomainException.RuleViolated("field-type", bad); }
            case "date" -> {
                try { return LocalDate.parse((String) v).toString(); } catch (RuntimeException e) { throw new DomainException.RuleViolated("field-type", "\"" + d.key() + "\" must be a date (yyyy-mm-dd)"); }
            }
            case "select" -> { if (v instanceof String s && d.options().contains(s)) return s; throw new DomainException.RuleViolated("field-option", "\"" + d.key() + "\" must be one of " + d.options()); }
            case "multiselect" -> {
                if (v instanceof Collection<?> c && c.stream().allMatch((x) -> x instanceof String s && d.options().contains(s))) return List.copyOf(c);
                throw new DomainException.RuleViolated("field-option", "\"" + d.key() + "\" must be some of " + d.options());
            }
            default -> throw new DomainException.RuleViolated("field-type", "\"" + d.key() + "\" cannot be set here");
        }
    }
}
