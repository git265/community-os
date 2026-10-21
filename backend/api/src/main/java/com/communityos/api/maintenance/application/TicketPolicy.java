package com.communityos.api.maintenance.application;

import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.shared.access.AccessPolicy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import java.util.UUID;

/**
 * Who sees which tickets:
 *  - a resident: their own units' tickets and every community request, and only of task types shown to residents (the committee's
 *    internal work - purchases, capital projects - never reaches them)
 *  - staff limited to blocks: their blocks' tickets and community requests
 *  - the committee and other staff: all; vendors: none (their jobs come with the vendor module)
 * Internal comments are hidden from residents (canSeeInternal).
 */
public final class TicketPolicy implements AccessPolicy<Ticket> {
    private static final Spec<Ticket> COMMUNITY = Spec.eq("t.scope", "Community", Ticket::community);

    @Override public Spec<Ticket> readScope(Caller c) {
        if (c.isSuperAdmin()) return Spec.all();
        return switch (c.category()) {
            case Resident -> Spec.<Ticket>in("t.unit_id", c.units().stream().map((u) -> u.value()).toList(), (t) -> t.unit() != null && c.units().contains(t.unit()))
                .or(COMMUNITY)
                .and(Spec.eq("tt.resident_visible", true, (t) -> t.taskType() == null || t.taskType().residentVisible()));
            case Vendor -> Spec.none();
            case EC, Staff, System -> c.isBlockLimited()
                ? Spec.<Ticket>in("u.block_id", c.blocks().stream().map((b) -> b.value()).toList(), (t) -> t.block() != null && c.blocks().contains(t.block())).or(COMMUNITY)
                : Spec.all();
        };
    }
    public static boolean canSeeInternal(Caller c) { return c.isSuperAdmin() || c.category() == Caller.Category.EC || c.category() == Caller.Category.Staff || c.category() == Caller.Category.System; }
}
