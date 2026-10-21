package com.communityos.api.shared.access;

import com.communityos.api.shared.security.Caller;

/**
 * Chain of Responsibility: one check of a command (signed in, permission, scope, business invariants ...). Each guard either passes the
 * command on or throws; the chain is assembled once per use case (GuardChain.of(...)), so the order is explicit and no check can be skipped.
 */
@FunctionalInterface
public interface Guard<C> {
    void check(Caller caller, C command);
}
