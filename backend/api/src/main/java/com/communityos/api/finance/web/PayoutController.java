package com.communityos.api.finance.web;

import com.communityos.api.finance.application.PayoutService;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.shared.tenancy.CallerHolder;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** A money-in bank line matched to the provider payout it is: the online payments it carries, less the provider's fees. */
@RestController
@Tag(name = "Finance")
public class PayoutController {
    public record PayoutRequest(@NotEmpty @Size(max = 2000) List<UUID> paymentIds) {}
    private final PayoutService payouts;
    public PayoutController(PayoutService payouts) { this.payouts = payouts; }

    @GetMapping("/api/v1/finance/bank-lines/{id}/payout")
    public PayoutService.Proposal propose(@PathVariable UUID id) { return payouts.propose(CallerHolder.require(), id); }
    @PostMapping("/api/v1/finance/bank-lines/{id}/payout")
    public Books.BankLine match(@PathVariable UUID id, @Valid @RequestBody PayoutRequest b) { return payouts.match(CallerHolder.require(), id, b.paymentIds()); }
}
