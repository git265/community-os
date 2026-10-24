package com.communityos.api.identity.adapter;

import com.communityos.api.shared.jdbc.Rows;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The public face of a community (sign-in page): id, name, status and time zone by its slug. Platform connection; no member data. */
public final class JdbcCommunityDirectory {
    /** timeZone: the community's clock (its planned times - meetings, pass hours - are in it; moments travel in UTC). */
    public record PublicCommunity(UUID id, String slug, String name, String status, String timeZone) {}
    static final String BY_SLUG = "SELECT id, slug, name, status, time_zone FROM platform.community WHERE slug = :slug";
    private final NamedParameterJdbcTemplate jdbc;
    public JdbcCommunityDirectory(NamedParameterJdbcTemplate platformJdbc) { this.jdbc = platformJdbc; }

    public Optional<PublicCommunity> bySlug(String slug) {
        if (slug == null || !slug.matches("[a-z0-9][a-z0-9-]{1,62}")) return Optional.empty();
        return jdbc.query(BY_SLUG, Map.of("slug", slug), (rs, i) -> new PublicCommunity(Rows.uuid(rs, "id"), rs.getString("slug"), rs.getString("name"), rs.getString("status"), rs.getString("time_zone")))
            .stream().findFirst();
    }
}
