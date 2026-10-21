package com.communityos.api.shared.access;

import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.List;

/** An ordered chain of guards (Chain of Responsibility), plus the common guards. */
public final class GuardChain<C> implements Guard<C> {
    private final List<Guard<C>> guards;
    private GuardChain(List<Guard<C>> guards) { this.guards = List.copyOf(guards); }

    @SafeVarargs public static <C> GuardChain<C> of(Guard<C>... guards) { return new GuardChain<>(List.of(guards)); }

    @Override public void check(Caller caller, C command) {
        if (caller == null) throw new AccessDenied("Sign in to continue");
        for (Guard<C> g : guards) g.check(caller, command);
    }

    /** Any one of the permissions (the Super Admin always passes). */
    public static <C> Guard<C> anyPermission(String message, Permission... perms) {
        return (caller, cmd) -> { if (!caller.isSuperAdmin() && !caller.hasAny(perms)) throw new AccessDenied(message); };
    }
    /** Residents are never allowed this command. */
    public static <C> Guard<C> notResident(String message) {
        return (caller, cmd) -> { if (caller.isResident()) throw new AccessDenied(message); };
    }
}
