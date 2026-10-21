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

    @PostMapping("/api/v1/dev/simulated-checkout/{providerOrderRef}")
    public Map<String, String> pay(@PathVariable String providerOrderRef, @RequestParam(defaultValue = "true") boolean succeed) { return gateway.simulatePay(providerOrderRef, succeed); }
}
