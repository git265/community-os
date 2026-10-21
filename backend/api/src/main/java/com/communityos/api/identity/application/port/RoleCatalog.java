package com.communityos.api.identity.application.port;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.Collection;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** The community's roles with their effective permissions. */
public interface RoleCatalog {
    record RoleRef(UUID id, String code, String name, Caller.Category category, Set<Permission> permissions) {}
    Map<String, RoleRef> byCodes(Collection<String> codes);
    /** Every role of the community (what the app needs to show menus; the server still decides every call). */
    java.util.List<RoleRef> all();
}
