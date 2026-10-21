package com.communityos.api.identity.web;

import com.communityos.api.identity.adapter.JdbcCommunityDirectory;
import com.communityos.api.identity.application.port.RoleCatalog;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.tenancy.CallerHolder;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** Small reads the app needs around sign-in: is the API up, which community is this page for, and the community's roles (for menus). */
@RestController
@Tag(name = "Directory")
public class DirectoryController {
    public record RoleResponse(String code, String name, String category, List<String> permissions) {}

    private final JdbcCommunityDirectory communities; private final RoleCatalog roles;
    public DirectoryController(JdbcCommunityDirectory communities, RoleCatalog roles) { this.communities = communities; this.roles = roles; }

    @GetMapping("/api/v1/public/health")
    public Map<String, String> health() { return Map.of("status", "UP", "api", "v2"); }

    @GetMapping("/api/v1/public/communities/{slug}")
    public JdbcCommunityDirectory.PublicCommunity community(@PathVariable String slug) {
        return communities.bySlug(slug).orElseThrow(() -> new DomainException.NotFound("Community"));
    }

    /** Signed-in members only. What a role may do is decided by the server on every call; this list only shapes the menus. */
    @GetMapping("/api/v1/roles")
    public List<RoleResponse> roles() {
        CallerHolder.require();
        return roles.all().stream().map((r) -> new RoleResponse(r.code(), r.name(), r.category().name(), r.permissions().stream().map(Enum::name).sorted().toList())).toList();
    }
}
