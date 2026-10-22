package com.communityos.api.billing.domain;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Reconciliation: what the money records say about each other and what the payment provider says, where they disagree.
 * A finding is about one record (or the whole ledger); the same finding seen again on a later run is the same issue.
 */
public final class Recon {
    private Recon() {}
    public static final String LATE_CAPTURE = "late-capture", DUPLICATE_CAPTURE = "duplicate-capture", AMOUNT_MISMATCH = "amount-mismatch",
        ALLOCATION_MISMATCH = "allocation-mismatch", BILL_PAID_MISMATCH = "bill-paid-mismatch", REFUND_UNANSWERED = "refund-unanswered",
        LEDGER_UNBALANCED = "ledger-unbalanced", CREDIT_MISMATCH = "credit-mismatch";
    /** Found by comparing the records (each run re-checks them: an open one that is no longer found is cleared). */
    public static final List<String> RECORD_CHECKS = List.of(DUPLICATE_CAPTURE, AMOUNT_MISMATCH, ALLOCATION_MISMATCH, BILL_PAID_MISMATCH, REFUND_UNANSWERED, LEDGER_UNBALANCED, CREDIT_MISMATCH);
    public static final List<String> STATUSES = List.of("Open", "Resolved", "Ignored");

    /** What a check found. */
    public record Finding(String kind, String refType, UUID refId, String refShortId, String providerRef, BigDecimal expected, BigDecimal actual, String detail) {
        public Finding { detail = detail == null ? kind : detail.length() > 500 ? detail.substring(0, 500) : detail; }
    }
    /** A finding kept for the treasurer. */
    public record Issue(UUID id, String shortId, String kind, String refType, UUID refId, String refShortId, String providerRef, BigDecimal expected, BigDecimal actual,
                        String detail, String status, String note, String resolvedByName, Instant resolvedAt, Instant foundAt, Instant lastSeenAt, long version) {}
}
