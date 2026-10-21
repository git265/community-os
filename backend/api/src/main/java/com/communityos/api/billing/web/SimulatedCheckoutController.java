package com.communityos.api.billing.web;

import com.communityos.api.billing.adapter.gateway.SimulatedGateway;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Development only: plays the provider's checkout page for the simulated gateway (registered only when cos.payments.simulated.enabled=true). */
@RestController
@ConditionalOnProperty(name = "cos.payments.simulated.enabled", havingValue = "true")
public class SimulatedCheckoutController {
    private final SimulatedGateway gateway;
    public SimulatedCheckoutController(SimulatedGateway gateway) { this.gateway = gateway; }

    /** outcome: success, failure (the bank declines), pending (the bank is slow) or lost (charged, but the app's confirmation is lost); `succeed` is the older form.
     *  payer: the UPI ID chosen in the simulated UPI app (kept on the payment with the bank's UTR). */
    @PostMapping("/api/v1/dev/simulated-checkout/{providerOrderRef}")
    public Map<String, String> pay(@PathVariable String providerOrderRef, @RequestParam(required = false) String outcome, @RequestParam(defaultValue = "true") boolean succeed,
                                   @RequestParam(required = false) String payer) {
        SimulatedGateway.Outcome o;
        try { o = outcome == null ? (succeed ? SimulatedGateway.Outcome.SUCCESS : SimulatedGateway.Outcome.FAILURE) : SimulatedGateway.Outcome.valueOf(outcome.toUpperCase(java.util.Locale.ROOT)); }
        catch (IllegalArgumentException e) { throw new com.communityos.api.shared.domain.DomainException.RuleViolated("bad-outcome", "outcome is success, failure, pending or lost"); }
        return gateway.simulate(providerOrderRef, o, payer == null || payer.isBlank() ? null : payer.strip().toLowerCase(java.util.Locale.ROOT));
    }

    public record BankMode(String service, Boolean refundsFail) {}
    /** How the simulated payment service answers now: normal, slow (each call takes slow-latency) or down; and whether refunds fail. */
    @org.springframework.web.bind.annotation.GetMapping("/api/v1/dev/simulated-bank")
    public Map<String, Object> bank() { return view(gateway.mode()); }
    @org.springframework.web.bind.annotation.PutMapping("/api/v1/dev/simulated-bank")
    public Map<String, Object> bank(@org.springframework.web.bind.annotation.RequestBody BankMode b) {
        com.communityos.api.shared.tenancy.CallerHolder.require();
        SimulatedGateway.Mode cur = gateway.mode();
        SimulatedGateway.Service svc;
        try { svc = b.service() == null ? cur.service() : SimulatedGateway.Service.valueOf(b.service().toUpperCase(java.util.Locale.ROOT)); }
        catch (IllegalArgumentException e) { throw new com.communityos.api.shared.domain.DomainException.RuleViolated("bad-service", "service is normal, slow or down"); }
        return view(gateway.mode(new SimulatedGateway.Mode(svc, b.refundsFail() == null ? cur.refundsFail() : b.refundsFail())));
    }
    private Map<String, Object> view(SimulatedGateway.Mode m) {
        var d = gateway.delays();
        return Map.of("service", m.service().name().toLowerCase(java.util.Locale.ROOT), "refundsFail", m.refundsFail(), "pendingSeconds", d.pending().toSeconds(),
            "lostSeconds", d.lost().toSeconds(), "refundSeconds", d.refund().toSeconds(), "slowSeconds", d.slowLatency().toSeconds());
    }
}
