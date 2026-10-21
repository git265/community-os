package com.communityos.api.identity.adapter;

import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.CallerLoader;
import com.communityos.api.shared.security.Permission;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.EnumSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * Loads the Caller in ONE round trip (the request path's only extra query), on the platform connection with an explicit community predicate
 * (there is no tenant context yet - this is what establishes it). Cached for a short time per membership so a burst of calls from one screen
 * costs one query; role changes evict the entry on this instance and expire everywhere within the TTL.
 *
 * Effective permissions = for each of the member's roles: its group's permissions + the role's grants - the role's revokes, then the union.
 * Category = the primary role's group (EC / Staff / Resident / Vendor).
 */
public final class JdbcCallerLoader implements CallerLoader {
    static final String LOAD = """
        SELECT m.id, m.person_id, m.display_name,
               (SELECT g.category FROM identity.membership_role mr
                  JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                  JOIN identity.role_group g ON g.community_id = r.community_id AND g.id = r.group_id
                 WHERE mr.community_id = m.community_id AND mr.membership_id = m.id
                 ORDER BY mr.is_primary DESC, array_position(ARRAY['EC', 'Staff', 'Vendor', 'Resident'], g.category) LIMIT 1) AS category,
               ARRAY(SELECT mr.role_id FROM identity.membership_role mr WHERE mr.community_id = m.community_id AND mr.membership_id = m.id) AS role_ids,
               ARRAY(SELECT r.code FROM identity.membership_role mr JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                      WHERE mr.community_id = m.community_id AND mr.membership_id = m.id ORDER BY mr.is_primary DESC, r.code) AS role_codes,
               (SELECT r.trade FROM identity.membership_role mr JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                 WHERE mr.community_id = m.community_id AND mr.membership_id = m.id AND r.trade IS NOT NULL ORDER BY mr.is_primary DESC LIMIT 1) AS trade,
               ARRAY(SELECT DISTINCT x.permission FROM (
                        SELECT mr.role_id, gp.permission FROM identity.membership_role mr
                          JOIN identity.role r ON r.community_id = mr.community_id AND r.id = mr.role_id
                          JOIN identity.role_group_permission gp ON gp.community_id = r.community_id AND gp.group_id = r.group_id
                         WHERE mr.community_id = m.community_id AND mr.membership_id = m.id
                        UNION
                        SELECT o.role_id, o.permission FROM identity.membership_role mr
                          JOIN identity.role_permission_override o ON o.community_id = mr.community_id AND o.role_id = mr.role_id AND o.effect = 'grant'
                         WHERE mr.community_id = m.community_id AND mr.membership_id = m.id) x
                      WHERE NOT EXISTS (SELECT 1 FROM identity.role_permission_override v WHERE v.community_id = m.community_id AND v.role_id = x.role_id
                                          AND v.permission = x.permission AND v.effect = 'revoke')) AS permissions,
               ARRAY(SELECT DISTINCT o.unit_id FROM property.occupant o
                      WHERE o.community_id = m.community_id AND o.person_id = m.person_id AND o.portal_access AND (o.to_date IS NULL OR o.to_date >= current_date)) AS units,
               ARRAY(SELECT b.block_id FROM identity.membership_block b WHERE b.community_id = m.community_id AND b.membership_id = m.id) AS blocks
        FROM identity.membership m
        JOIN platform.community c ON c.id = m.community_id AND c.status = 'Active'
        JOIN identity.person p ON p.id = m.person_id AND p.status = 'Active'
        WHERE m.community_id = CAST(:community AS uuid) AND m.id = CAST(:membership AS uuid) AND m.person_id = CAST(:person AS uuid) AND m.status = 'Active'""";

    private record Entry(Caller caller, Instant loadedAt) {}
    private final NamedParameterJdbcTemplate jdbc; private final Duration ttl; private final Clock clock;
    private final Map<MembershipId, Entry> cache = new ConcurrentHashMap<>();

    public JdbcCallerLoader(NamedParameterJdbcTemplate platformJdbc, Duration ttl, Clock clock) { this.jdbc = platformJdbc; this.ttl = ttl; this.clock = clock; }

    @Override public Optional<Caller> load(PersonId person, CommunityId community, MembershipId membership) {
        Entry e = cache.get(membership);
        Instant now = clock.instant();
        if (e != null && e.loadedAt().plus(ttl).isAfter(now) && e.caller().person().equals(person) && e.caller().community().equals(community)) return Optional.of(e.caller());
        Optional<Caller> loaded = jdbc.query(LOAD, Map.of("community", community.toString(), "membership", membership.toString(), "person", person.toString()), (rs, i) -> {
            String category = rs.getString("category");
            Set<Permission> perms = EnumSet.noneOf(Permission.class);
            for (String p : Rows.list(rs, "permissions", String::valueOf)) { try { perms.add(Permission.valueOf(p)); } catch (IllegalArgumentException ignored) { /* a newer permission this build does not know */ } }
            return new Caller(person, membership, community, rs.getString("display_name"), category == null ? Caller.Category.Resident : Caller.Category.valueOf(category),
                Rows.set(rs, "role_codes", String::valueOf), perms, Rows.set(rs, "units", (o) -> new UnitId((UUID) o)), Rows.set(rs, "blocks", (o) -> new BlockId((UUID) o)),
                rs.getString("trade"), Rows.set(rs, "role_ids", (o) -> (UUID) o));
        }).stream().findFirst();
        loaded.ifPresentOrElse((c) -> { if (cache.size() > 50_000) cache.clear(); cache.put(membership, new Entry(c, now)); }, () -> cache.remove(membership));
        return loaded;
    }
    @Override public void evict(MembershipId membership) { cache.remove(membership); }
}
