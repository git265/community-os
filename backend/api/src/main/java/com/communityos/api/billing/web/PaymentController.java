package com.communityos.api.billing.web;

import com.communityos.api.billing.application.CounterSettlement;
import com.communityos.api.billing.application.PaymentService;
import com.communityos.api.billing.web.BillingDtos.ConfirmRequest;
import com.communityos.api.billing.web.BillingDtos.CounterReceiptRequest;
import com.communityos.api.billing.web.BillingDtos.CreateOrderRequest;
import com.communityos.api.billing.web.BillingDtos.OrderResponse;
import com.communityos.api.billing.web.BillingDtos.ReceiptResponse;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.Idempotency;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Tag(name = "Payments")
public class PaymentController {
    private final PaymentService payments; private final CounterSettlement counter; private final Idempotency idempotency;
    public PaymentController(PaymentService payments, CounterSettlement counter, Idempotency idempotency) { this.payments = payments; this.counter = counter; this.idempotency = idempotency; }

    @PostMapping("/api/v1/payment-orders") @Operation(summary = "Start paying bills online (the server prices them)")
    public ResponseEntity<OrderResponse> create(@Valid @RequestBody CreateOrderRequest b, @RequestHeader(name = "Idempotency-Key", required = false) String key) {
        PaymentService.OrderView v = payments.createOrder(CallerHolder.require(), new PaymentService.CreateOrder(b.dueIds() == null ? List.of() : b.dueIds().stream().map(DueId::new).toList(),
            b.purpose() == null ? "due" : b.purpose(), b.unitId() == null ? null : new UnitId(b.unitId()), b.amount()), key);
        return ResponseEntity.status(201).body(OrderResponse.of(v));
    }
    @GetMapping("/api/v1/payment-orders/{id}")
    public OrderResponse get(@PathVariable UUID id) { return OrderResponse.of(payments.getOrder(CallerHolder.require(), new OrderId(id))); }

    @PostMapping("/api/v1/payment-orders/{id}/confirm") @Operation(summary = "The checkout's callback: verified with the provider, then receipted")
    public ReceiptResponse confirm(@PathVariable UUID id, @Valid @RequestBody ConfirmRequest b) {
        return ReceiptResponse.of(payments.confirm(CallerHolder.require(), new OrderId(id), b.providerPaymentRef(), b.signature()));
    }

    @PostMapping("/api/v1/payments") @Operation(summary = "Record money received at the office")
    public ResponseEntity<ReceiptResponse> counter(@Valid @RequestBody CounterReceiptRequest b, @RequestHeader(name = "Idempotency-Key", required = false) String key) {
        Caller c = CallerHolder.require();
        Idempotency.Reply<ReceiptResponse> r = idempotency.run(c, key, "POST /api/v1/payments", b, ReceiptResponse.class, 201, () -> ReceiptResponse.of(counter.settle(c,
            new CounterSettlement.Request(new UnitId(b.unitId()), b.amount(), b.method(), b.receivedOn(), b.dueIds() == null ? null : b.dueIds().stream().map(DueId::new).toList(), b.reference()))));
        return ResponseEntity.status(r.status()).body(r.body());
    }

    /** Provider webhooks: no bearer token; authenticated by the signature on the raw body. Always 200 once handled so the provider stops retrying. */
    @PostMapping("/api/v1/webhooks/{provider}")
    public Map<String, Object> webhook(@PathVariable String provider, @RequestHeader Map<String, String> headers, @RequestBody byte[] body) {
        if (body.length > 256 * 1024) throw new com.communityos.api.shared.domain.DomainException.RuleViolated("too-large", "Body too large");
        Map<String, String> lower = new LinkedHashMap<>();
        headers.forEach((k, v) -> lower.put(k.toLowerCase(java.util.Locale.ROOT), v));
        payments.webhook(provider, lower, body);
        return Map.of("received", true);
    }
}
