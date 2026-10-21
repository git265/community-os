package com.communityos.api.shared.jdbc;

import com.communityos.api.shared.custom.CustomFields;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** config.field_definition rows of one entity that live in `custom` (RLS keeps them to the caller's community). */
public final class JdbcFieldDefinitions implements CustomFields.Definitions {
    static final String BY_ENTITY = """
        SELECT field_key, data_type, required, options, edit_roles FROM config.field_definition WHERE entity = :entity AND is_custom ORDER BY sort_order, field_key""";
    private final NamedParameterJdbcTemplate jdbc;
    public JdbcFieldDefinitions(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public List<CustomFields.Definition> of(String entity) {
        return jdbc.query(BY_ENTITY, Map.of("entity", entity), (rs, i) -> new CustomFields.Definition(rs.getString("field_key"), rs.getString("data_type"),
            rs.getBoolean("required"), Rows.list(rs, "options", String::valueOf), Rows.set(rs, "edit_roles", (o) -> (UUID) o)));
    }
}
