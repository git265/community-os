package com.communityos.api.billing.web;

import com.communityos.api.billing.application.PaymentService;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.billing.domain.PaymentOrder;
import com.communityos.api.shared.domain.Money;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Billing bodies. Note what is NOT in the requests: no status, no paid amount, no tax, no total, and no amount on a payment order - the server
 * computes all of them. Sending any of them is a 400 (unknown property).
 */
public final class BillingDtos {
    private BillingDtos() {}

    public record RaiseDueRequest(@NotNull UUID unitId, @NotBlank @Size(max = 40) String categoryCode, LocalDate billedMonth, @Size(max = 500) String description,
                                  @NotNull Money amount, @NotNull LocalDate dueDate) {}
    public record ReasonRequest(@NotBlank @Size(min = 3, max = 500) String reason) {}
    public record DueResponse(UUID id, String shortId, UUID unitId, String unitNo, String categoryCode, String category, boolean utility, LocalDate billedMonth, String description,
                              Money amount, Money tax, Money total, Money paid, Money outstanding, LocalDate dueDate, String status, Instant paidAt, String reason, long version) {
        static DueResponse of(Due d) {
            return new DueResponse(d.id().value(), d.shortId(), d.unit() == null ? null : d.unit().value(), d.unitNo(), d.category().code(), d.category().name(), d.category().utility(),
                d.billedMonth(), d.description(), d.amount(), d.tax(), d.total(), d.paid().plus(d.credit()), d.outstanding(), d.dueDate(), d.status().label(), d.paidAt(), d.cancelReason(), d.version());
        }
    }

    /** Bills: dueIds (the server prices them). A booking / donation paid before it is made: purpose + unitId + amount (checked when it is claimed). */
    public record CreateOrderRequest(@Size(max = 24) List<@NotNull UUID> dueIds, @jakarta.validation.constraints.Pattern(regexp = "due|booking|donation") String purpose, UUID unitId, Money amount) {}
    public record OrderResponse(UUID id, String shortId, String purpose, UUID unitId, Money amount, String currency, String status, String provider, Instant expiresAt, List<Item> items,
                                Map<String, Object> checkout, UUID paymentId) {
        public record Item(String targetType, UUID targetId, UUID dueId, Money amount) {}
        static OrderResponse of(PaymentService.OrderView v) {
            PaymentOrder o = v.order();
            return new OrderResponse(o.id().value(), o.shortId(), o.purpose(), o.unit().value(), o.amount(), o.currency(), o.status().label(), o.provider(), o.expiresAt(),
                o.items().stream().map((i) -> new Item(i.targetType(), i.target(), i.due() == null ? null : i.due().value(), i.amount())).toList(), v.checkout(), v.paymentId());
        }
    }
    public record ConfirmRequest(@NotBlank @Size(max = 60) String providerPaymentRef, @NotBlank @Size(max = 200) String signature) {}
    public record CounterReceiptRequest(@NotNull UUID unitId, @NotNull Money amount, @NotBlank String method, LocalDate receivedOn, @Size(max = 50) List<@NotNull UUID> dueIds,
                                        @Size(max = 100) String reference) {}
    public record ReceiptResponse(UUID paymentId, String receiptNo, UUID unitId, UUID orderId, Money amount, String method, String provider, Instant receivedAt,
                                  List<Allocation> allocations, Money keptAsCredit) {
        public record Allocation(String targetType, UUID targetId, UUID dueId, Money amount) {}
        static ReceiptResponse of(PaymentRepository.Receipt r) {
            return new ReceiptResponse(r.id().value(), r.receiptNo(), r.unit().value(), r.order() == null ? null : r.order().value(), r.amount(), r.method(), r.provider(), r.receivedAt(),
                r.allocations().stream().map((a) -> new Allocation(a.targetType(), a.targetId(), a.dueId() == null ? null : a.dueId().value(), a.amount())).toList(), r.toCredit());
        }
    }
}
