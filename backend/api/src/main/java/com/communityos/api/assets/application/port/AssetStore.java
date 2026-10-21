package com.communityos.api.assets.application.port;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Stock and the condition log - explicit SQL behind it (JdbcAssetStore). */
public interface AssetStore {
    record Stock(UUID id, String shortId, String item, String uom, BigDecimal quantity, BigDecimal minStock, LocalDate lastRestocked, long version) {
        public boolean low() { return minStock != null && quantity.compareTo(minStock) <= 0; }
    }
    Optional<Stock> stock(UUID itemId, boolean lock);
    record Movement(UUID id, String shortId, UUID itemId, String kind, BigDecimal quantity, BigDecimal balance, LocalDate onDate, UUID ticketId, String vendor, String note,
                    UUID byId, String by, Instant at) {}
    /** The movement and the item's new quantity, in one go (the item is locked by the caller). */
    Movement move(Stock item, String kind, BigDecimal quantity, BigDecimal balance, LocalDate on, UUID ticketId, String vendor, String note);
    List<Movement> movements(UUID itemId);

    record Asset(UUID id, String name, String status, LocalDate lastInspected) {}
    Optional<Asset> asset(UUID id, boolean lock);
    record ConditionEntry(UUID id, String shortId, UUID assetId, String assetName, LocalDate date, String condition, String source, String note, UUID ticketId, UUID byId, Instant at) {}
    /** The entry, and the asset's condition and last inspection when this is its latest news. */
    ConditionEntry recordCondition(Asset a, LocalDate date, String condition, String source, String note, UUID ticketId, boolean latest);
    boolean ticketExists(UUID ticketId);
}
