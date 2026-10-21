package com.communityos.api.billing.application.gateway;

import com.communityos.api.shared.domain.DomainException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Registry / factory of the configured providers, by name. */
public final class GatewayRegistry {
    private final Map<String, PaymentGateway> byName = new LinkedHashMap<>();
    private final String defaultName;

    public GatewayRegistry(List<PaymentGateway> gateways, String defaultName) {
        for (PaymentGateway g : gateways) byName.put(g.name(), g);
        if (!byName.containsKey(defaultName)) throw new IllegalStateException("payments.default-provider " + defaultName + " is not configured; have " + byName.keySet());
        this.defaultName = defaultName;
    }
    public PaymentGateway get(String name) {
        PaymentGateway g = byName.get(name);
        if (g == null) throw new DomainException.NotFound("Payment provider " + name);
        return g;
    }
    public PaymentGateway defaultGateway() { return byName.get(defaultName); }
}
