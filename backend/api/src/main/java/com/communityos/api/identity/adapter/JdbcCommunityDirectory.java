package com.communityos.api.identity.adapter;

import com.communityos.api.shared.jdbc.Rows;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The public face of a community (sign-in page): id, name and status by its slug. Platform connection; no member data. */
public final class JdbcCommunityDirectory {
    public record PublicCommunity(UUID id, String slug, String name, String status) {}
    static final String BY_SLUG = "SELECT id, slug, name, status FROM platform.community WHERE slug = :slug";
    private final NamedParameterJdbcTemplate jdbc;
    public JdbcCommunityDirectory(NamedParameterJdbcTemplate platformJdbc) { this.jdbc = platformJdbc; }

    public Optional<PublicCommunity> bySlug(String slug) {
        if (slug == null || !slug.matches("[a-z0-9][a-z0-9-]{1,62}")) return Optional.empty();
        return jdbc.query(BY_SLUG, Map.of("slug", slug), (rs, i) -> new PublicCommunity(Rows.uuid(rs, "id"), rs.getString("slug"), rs.getString("name"), rs.getString("status")))
            .stream().findFirst();
    }
}
