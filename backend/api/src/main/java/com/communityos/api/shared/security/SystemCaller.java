package com.communityos.api.shared.security;

import com.communityos.api.shared.domain.Ids.CommunityId;
import java.util.EnumSet;
import java.util.Set;

/** The caller a scheduled job or a provider webhook acts as: one community, no person, only the permissions the job needs. */
public final class SystemCaller {
    private SystemCaller() {}
    public static Caller of(CommunityId community, String job, Permission... permissions) {
        Set<Permission> p = permissions.length == 0 ? Set.of() : EnumSet.of(permissions[0], permissions);
        return new Caller(null, null, community, "System · " + job, Caller.Category.System, Set.of("system"), p, Set.of(), Set.of(), null, Set.of());
    }
}
