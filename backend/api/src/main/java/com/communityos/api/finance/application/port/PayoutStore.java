package com.communityos.api.finance.application.port;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

/** Online payments not yet in a provider payout (explicit SQL over billing.payment: JdbcPayoutStore). */
public interface PayoutStore {
    record OnlinePayment(UUID id, String receiptNo, String provider, BigDecimal amount, Instant receivedAt) {}
    /** Received up to and including `upTo`, oldest first. */
    List<OnlinePayment> unsettled(LocalDate upTo);
    /** These payments, locked, if none is in a payout yet. */
    List<OnlinePayment> lock(Collection<UUID> ids);
    void settled(Collection<UUID> ids, UUID entryId);
}
