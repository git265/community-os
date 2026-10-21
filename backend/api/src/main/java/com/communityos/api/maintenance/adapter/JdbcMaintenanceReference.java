package com.communityos.api.maintenance.adapter;

import com.communityos.api.shared.jdbc.Rows;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Read-only reference lists for the tickets screen: category coverage and quick phrases (tenant connection). */
public final class JdbcMaintenanceReference {
    public record Category(UUID id, String category, List<String> subCategories, List<String> coordinatorRoles, String assetLink, String notes) {}
    public record Phrase(UUID id, String phrase, String category) {}
    static final String CATEGORIES = "SELECT id, category, sub_categories, coordinator, asset_link, notes FROM maintenance.category_coverage ORDER BY category";
    static final String PHRASES = "SELECT id, phrase, category FROM maintenance.quick_phrase ORDER BY created_at, phrase";
    private final NamedParameterJdbcTemplate jdbc;
    public JdbcMaintenanceReference(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    public List<Category> categories() {
        return jdbc.query(CATEGORIES, Map.of(), (rs, i) -> new Category(Rows.uuid(rs, "id"), rs.getString("category"), Rows.list(rs, "sub_categories", String::valueOf),
            Rows.list(rs, "coordinator", String::valueOf), rs.getString("asset_link"), rs.getString("notes")));
    }
    public List<Phrase> phrases() { return jdbc.query(PHRASES, Map.of(), (rs, i) -> new Phrase(Rows.uuid(rs, "id"), rs.getString("phrase"), rs.getString("category"))); }
}
