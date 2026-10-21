package com.communityos.api.amenity.application.port;

import com.communityos.api.amenity.domain.AmenityType;
import com.communityos.api.amenity.domain.Pricing;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port: what the booking rules read - amenities, add-on items, settings, the unit, and whether it is held back for overdue dues. */
public interface AmenityCatalog {
    record Settings(BigDecimal defaultGstRate, boolean refundToCredit, int paymentDueHours) {}
    record UnitInfo(UnitId id, String unitNo, String unitType, BlockId block) {}
    /** The amenity, locked for this transaction: bookings of one amenity are decided one at a time (no double booking). */
    Optional<AmenityType> lockType(UUID id);
    Optional<AmenityType> type(UUID id);
    List<Pricing.Item> items();
    Settings settings();
    Optional<UnitInfo> unit(UnitId unit);
    /** Why this unit may not book (overdue dues, when the community blocks defaulters), or null. */
    String defaulterHold(UnitId unit, LocalDate today);
}
