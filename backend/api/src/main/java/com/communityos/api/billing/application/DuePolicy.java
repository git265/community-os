package com.communityos.api.billing.application;

import com.communityos.api.billing.domain.Due;
import com.communityos.api.shared.access.AccessPolicy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.UUID;

/**
 * Bills:
 *  - a resident sees the bills of their own units, and only those
 *  - finance (MANAGE_DUES, MANAGE_LEDGER) and the Super Admin see all; utility billing / meter-reading roles see utility bills only
 *  - staff limited to blocks see only their blocks' bills
 *  - everyone else sees none
 * Changing (raise, cancel, waive): MANAGE_DUES for all categories, MANAGE_UTILITY_BILLING for utility categories; never a resident.
 */
public final class DuePolicy implements AccessPolicy<Due> {
    private static final Spec<Due> UTILITY = Spec.eq("c.is_utility", true, (d) -> d.category().utility());

    @Override public Spec<Due> readScope(Caller c) {
        if (c.isSuperAdmin()) return Spec.all();
        if (c.isResident()) return Spec.in("d.unit_id", c.units().stream().map((u) -> u.value()).toList(), (d) -> d.unit() != null && c.units().contains(d.unit()));
        Spec<Due> s;
        if (c.hasAny(Permission.MANAGE_DUES, Permission.MANAGE_LEDGER)) s = Spec.all();
        else if (c.hasAny(Permission.MANAGE_UTILITY_BILLING, Permission.MANAGE_UTILITY_READINGS)) s = UTILITY;
        else return Spec.none();
        return c.isBlockLimited() ? s.and(blocks(c)) : s;
    }

    @Override public Spec<Due> writeScope(Caller c) {
        if (c.isSuperAdmin()) return Spec.all();
        if (c.isResident()) return Spec.none();
        Spec<Due> s;
        if (c.has(Permission.MANAGE_DUES)) s = Spec.all();
        else if (c.has(Permission.MANAGE_UTILITY_BILLING)) s = UTILITY;
        else return Spec.none();
        return c.isBlockLimited() ? s.and(blocks(c)) : s;
    }

    /** May this caller pay these bills online? Their own unit's bills, or anyone's with MANAGE_DUES (paying at the desk on someone's behalf). */
    public boolean mayPay(Caller c, Due d) {
        if (d.unit() == null) return false;
        if (c.isResident()) return c.units().contains(d.unit());
        return c.isSuperAdmin() || c.has(Permission.MANAGE_DUES);
    }

    private static Spec<Due> blocks(Caller c) {
        java.util.List<UUID> ids = c.blocks().stream().map((b) -> b.value()).toList();
        return Spec.in("u.block_id", ids, (d) -> d.block() != null && c.blocks().contains(d.block()));
    }
}
