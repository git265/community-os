package com.communityos.api.property.application;

import com.communityos.api.property.domain.Unit;
import com.communityos.api.shared.access.AccessPolicy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.UUID;

/**
 * Units: a resident sees only the units they live in or own; staff limited to blocks see those blocks; the committee and other staff see all.
 * Vendors see none. Only MANAGE_UNITS (or the Super Admin) changes a unit, within the same block limit.
 */
public final class UnitPolicy implements AccessPolicy<Unit> {
    @Override public Spec<Unit> readScope(Caller c) {
        if (c.isSuperAdmin()) return Spec.all();
        return switch (c.category()) {
            case Resident -> Spec.in("u.id", c.units().stream().map((x) -> x.value()).toList(), (u) -> c.units().contains(u.id()));
            case Vendor -> Spec.none();
            case EC, Staff, System -> c.isBlockLimited() ? blocks(c) : Spec.all();
        };
    }
    @Override public Spec<Unit> writeScope(Caller c) {
        if (c.isSuperAdmin()) return Spec.all();
        if (!c.has(Permission.MANAGE_UNITS) || c.isResident()) return Spec.none();
        return c.isBlockLimited() ? blocks(c) : Spec.all();
    }
    private static Spec<Unit> blocks(Caller c) {
        java.util.List<UUID> ids = c.blocks().stream().map((b) -> b.value()).toList();
        return Spec.in("u.block_id", ids, (u) -> u.block() != null && c.blocks().contains(u.block()));
    }
}
