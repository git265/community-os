package com.communityos.api.amenity.application.port;

import com.communityos.api.amenity.domain.Booking;
import com.communityos.api.amenity.domain.Pricing;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/** Port: bookings in the caller's community. */
public interface BookingRepository {
    record Filter(UUID amenityTypeId, LocalDate from, LocalDate to, String status, UUID unit, boolean openMoney) {}
    /** How full a date / slot is, and the add-on items held there (no names, no units: safe for anyone to see). */
    record Taken(UUID amenityTypeId, LocalDate date, String slot, int bookings, Map<UUID, Integer> items) {}

    List<Booking> find(Spec<Booking> scope, Filter f);
    Optional<Booking> get(UUID id, Spec<Booking> scope);
    void insert(Booking b);
    boolean save(Booking b);
    /** Live (not cancelled) bookings of an amenity on a date. */
    List<Booking> liveOn(UUID amenityTypeId, LocalDate date);
    /** A unit's live bookings of an amenity, for its limits. */
    List<Pricing.Held> heldBy(UUID amenityTypeId, UnitId unit);
    List<Taken> taken(UUID amenityTypeId, LocalDate from, LocalDate to);
}
