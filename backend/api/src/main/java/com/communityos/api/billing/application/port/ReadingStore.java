package com.communityos.api.billing.application.port;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Optional;
import java.util.UUID;

/** What publishing a meter reading reads and writes (explicit SQL: JdbcReadingStore). */
public interface ReadingStore {
    record Draft(UUID id, String shortId, UUID unitId, String utility, String month, BigDecimal previous, BigDecimal current, BigDecimal units, String status, long version) {}
    record RateCard(BigDecimal ratePerUnit, BigDecimal fixedCharge, BigDecimal tax) {}
    /** The reading, locked for this transaction. */
    Optional<Draft> lock(UUID id);
    Optional<RateCard> rateCard(String utility);
    /** What the utility is measured in (kL, kWh ...), for the bill's line. */
    String unitName(String utility);
    int photos(UUID readingId);
    /** Draft -> Published with the bill it raised; false when it was no longer the draft that was read. */
    boolean published(UUID id, long version, UUID dueId, LocalDate on);
    void linkBill(UUID dueId, UUID readingId);
}
