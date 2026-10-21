package com.communityos.api.identity.adapter;

import com.communityos.api.identity.application.port.RoleCatalog;
import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.Collection;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Roles of the caller's community with their effective permissions (group + grants - revokes). */
public final class JdbcRoleCatalog implements RoleCatalog {
    static final String BY_CODES = """
        SELECT r.id, r.code, r.name, g.category,
               ARRAY(SELECT gp.permission FROM identity.role_group_permission gp WHERE gp.community_id = r.community_id AND gp.group_id = r.group_id
                     UNION SELECT o.permission FROM identity.role_permission_override o WHERE o.community_id = r.community_id AND o.role_id = r.id AND o.effect = 'grant'
                     EXCEPT SELECT o.permission FROM identity.role_permission_override o WHERE o.community_id = r.community_id AND o.role_id = r.id AND o.effect = 'revoke') AS permissions
        FROM identity.role r JOIN identity.role_group g ON g.community_id = r.community_id AND g.id = r.group_id
        WHERE r.code IN (:codes)""";
    static final String ALL = BY_CODES.replace("WHERE r.code IN (:codes)", "ORDER BY g.category, r.name");
    private final NamedParameterJdbcTemplate jdbc;
    public JdbcRoleCatalog(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public java.util.List<RoleRef> all() { return java.util.List.copyOf(run(ALL, Map.of()).values()); }
    @Override public Map<String, RoleRef> byCodes(Collection<String> codes) {
        if (codes.isEmpty()) return new LinkedHashMap<>();
        return run(BY_CODES, Map.of("codes", java.util.List.copyOf(codes)));
    }
    private Map<String, RoleRef> run(String sql, Map<String, Object> params) {
        Map<String, RoleRef> out = new LinkedHashMap<>();
        jdbc.query(sql, params, (rs, i) -> {
            Set<Permission> perms = EnumSet.noneOf(Permission.class);
            for (String p : Rows.list(rs, "permissions", String::valueOf)) { try { perms.add(Permission.valueOf(p)); } catch (IllegalArgumentException ignored) { } }
            RoleRef r = new RoleRef(Rows.uuid(rs, "id"), rs.getString("code"), rs.getString("name"), Caller.Category.valueOf(rs.getString("category")), perms);
            out.put(r.code(), r);
            return r;
        });
        return out;
    }
}
