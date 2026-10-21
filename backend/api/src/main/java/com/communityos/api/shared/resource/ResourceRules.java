package com.communityos.api.shared.resource;

import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.function.Predicate;

/**
 * Strategy: the rules of one resource - who reads it (as a row specification), who writes it, how an incoming record is checked and
 * normalised, and whether it may be deleted. Every resource has one; the generic service never decides anything itself.
 */
public interface ResourceRules<F extends Record> {
    /** The rows this caller may read (SQL on alias r + the same rule in memory). */
    default Spec<F> readScope(Caller c) { return c.category() == Caller.Category.Vendor ? Spec.none() : Spec.all(); }
    boolean mayWrite(Caller c);
    /** Check and normalise a create (existing == null) or an update. Throw DomainException.RuleViolated to refuse. */
    default F validate(Caller c, F incoming, F existing) { return incoming; }
    default boolean deletable(F existing) { return true; }
    /** May this caller change (or delete) this particular row? (Its server columns - who created it ... - are in the item.) */
    default boolean mayChange(Caller c, Item<F> existing) { return true; }
    /** The caller's own rows: true when the server column holding a membership id is the caller. */
    static boolean mine(Caller c, Item<?> it, String whoField) {
        Object v = it.server(whoField);
        return v != null && c.membership() != null && v.toString().equals(c.membership().toString());
    }
    /** A short name for the audit trail ("Clubhouse", "Gate 2 checkpoint"). */
    default String label(F f) { return ""; }

    // ---- common building blocks --------------------------------------------------------------------------------------------------------------
    static boolean any(Caller c, Permission... perms) { return c.isSuperAdmin() || c.hasAny(perms); }
    static boolean committee(Caller c) { return c.isSuperAdmin() || c.category() == Caller.Category.EC; }
    static boolean staffOrCommittee(Caller c) { return committee(c) || c.category() == Caller.Category.Staff; }
    static <F extends Record> Spec<F> only(Predicate<Caller> who, Caller c) { return who.test(c) ? Spec.all() : Spec.none(); }
}
