package com.communityos.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import com.communityos.service.PaymentService;
import com.communityos.service.TenantGuard;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import java.util.stream.Collectors;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** The four endpoints the UI's SpringGateway calls (src/lib/payments/SpringGateway.js). The webhook is open: its HMAC is the credential. */
@Tag(name = "Payments")
@RestController
public class PaymentController {
    private final PaymentService payments;
    private final TenantGuard guard;

    public PaymentController(PaymentService payments, TenantGuard guard) { this.payments = payments; this.guard = guard; }

    @Operation(summary = "Create a payment order", description = "The server prices the order from the bills / pledge; the client never sends the amount to charge. Asking twice returns the same open order. `quote: true` returns the price only.")
    @PostMapping("/api/payments/orders")
    public JsonNode create(@RequestBody JsonNode req, @RequestHeader("X-Community-Id") String c, Authentication who) {
        return payments.createOrder(guard.resolve(c, who), who, req);
    }

    @Operation(summary = "Get an order and its status", description = "Only the payer, the unit, or the finance team can see an order.")
    @GetMapping("/api/payments/orders/{id}")
    public JsonNode order(@PathVariable String id, @RequestHeader("X-Community-Id") String c, Authentication who) {
        return payments.getOrder(guard.resolve(c, who), who, Names.id(id));
    }

    @Operation(summary = "Play the bank (development only)", description = "With the simulated provider: success | failure | pending, optionally without delivering the webhook (so the reconcile job has to finish it). 404 once app.payments.allow-simulated=false.")
    @PostMapping("/api/payments/simulate/{id}")
    public Map<String, Object> simulate(@PathVariable String id, @RequestBody JsonNode req, @RequestHeader("X-Community-Id") String c, Authentication who) {
        return payments.simulate(guard.resolve(c, who), who, Names.id(id), req);
    }

    @Operation(summary = "Refund a payment", description = "Finance team only.")
    @PostMapping("/api/payments/refunds")
    public Map<String, Object> refund(@RequestBody JsonNode req, @RequestHeader("X-Community-Id") String c, Authentication who) {
        return payments.refund(guard.resolve(c, who), who, req);
    }

    @Operation(summary = "Provider webhook", description = "Open route; proves itself with a signature.")
    @PostMapping("/api/payments/webhook/{provider}")
    public ResponseEntity<Map<String, Object>> webhook(@PathVariable String provider, @RequestBody String raw, HttpServletRequest req) {
        Map<String, String> headers = java.util.Collections.list(req.getHeaderNames()).stream()
                .collect(Collectors.toMap(String::toLowerCase, req::getHeader, (a, b) -> a));
        return ResponseEntity.ok(payments.webhook(raw, headers));
    }
}
