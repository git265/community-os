package com.communityos.payments;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * One online payment, as the `payment_orders` table holds it (db/V3). The amount is priced by the server and is what the provider's
 * webhook is checked against; the browser never supplies it.
 *
 * @param status Created | Pending | Paid | Failed | Expired
 * @param refs   what is being paid: due ids, a donation id, or empty for a booking
 */
public record PaymentOrder(String orderId, String tenant, String purpose, List<String> refs, String unit, String payer, String payerId,
                           BigDecimal amount, String currency, String status, String idempotencyKey, JsonNode meta, String provider,
                           String providerRef, String paymentId, String method, JsonNode bank, String consumedBy, String note,
                           int attempts, Instant createdAt, Instant updatedAt, Instant paidAt) {

    public boolean open() { return "Created".equals(status) || "Pending".equals(status); }
}
