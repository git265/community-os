package com.communityos.api.amenity.application;

import com.communityos.api.amenity.domain.Booking;
import com.communityos.api.shared.access.AccessPolicy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;

/**
 * Who sees which bookings: a resident their own units' bookings (others' only as counts, through availability); the committee, the
 * amenities team and other staff all of them; vendors none. Who runs the money side: the amenities team (staff()).
 */
public final class BookingPolicy implements AccessPolicy<Booking> {
    @Override public Spec<Booking> readScope(Caller c) {
        if (c.isSuperAdmin()) return Spec.all();
        return switch (c.category()) {
            case Resident -> Spec.in("b.unit_id", c.units().stream().map((u) -> u.value()).toList(), (b) -> b.unit() != null && c.units().contains(b.unit()));
            case Vendor -> Spec.none();
            case EC, Staff, System -> Spec.all();
        };
    }
    /** The amenities team: the Super Admin, committee members and roles with MANAGE_AMENITIES. */
    public static boolean staff(Caller c) { return c.isSuperAdmin() || c.isCommittee() || c.has(Permission.MANAGE_AMENITIES); }
}
