package com.communityos.api.config;

import com.communityos.api.billing.adapter.JdbcBillingLookups;
import com.communityos.api.billing.adapter.JdbcDueRepository;
import com.communityos.api.billing.adapter.JdbcJournalWriter;
import com.communityos.api.billing.adapter.JdbcPaymentOrderRepository;
import com.communityos.api.billing.adapter.JdbcPaymentRepository;
import com.communityos.api.billing.adapter.JdbcPlatformPayments;
import com.communityos.api.billing.adapter.gateway.RazorpayGateway;
import com.communityos.api.billing.adapter.gateway.SimulatedGateway;
import com.communityos.api.billing.application.CounterSettlement;
import com.communityos.api.billing.application.DueService;
import com.communityos.api.billing.application.GatewaySettlement;
import com.communityos.api.billing.application.LedgerPoster;
import com.communityos.api.billing.application.PaymentService;
import com.communityos.api.billing.application.gateway.GatewayRegistry;
import com.communityos.api.billing.application.gateway.PaymentGateway;
import com.communityos.api.property.adapter.JdbcUnitRepository;
import com.communityos.api.property.application.UnitService;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.custom.CustomFields;
import com.communityos.api.shared.events.DomainEventHandler;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.http.HttpTransport;
import com.communityos.api.shared.resilience.CircuitBreaker;
import com.communityos.api.shared.resilience.Resilient;
import com.communityos.api.shared.resilience.RetryPolicy;
import com.communityos.api.shared.tx.Tx;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Property and billing wiring. Gateways are a registry of strategies; the ledger poster's handlers join the event dispatcher. */
@Configuration
public class ModulesConfig {
    @Bean UnitService unitService(NamedParameterJdbcTemplate jdbc, ObjectMapper json, CustomFields custom, AuditWriter audit, Tx tx) {
        return new UnitService(new JdbcUnitRepository(jdbc, json), custom, audit, tx);
    }

    @Bean JdbcDueRepository dueRepository(NamedParameterJdbcTemplate jdbc) { return new JdbcDueRepository(jdbc); }
    @Bean JdbcBillingLookups billingLookups(NamedParameterJdbcTemplate jdbc) { return new JdbcBillingLookups(jdbc); }
    @Bean JdbcPaymentRepository paymentRepository(NamedParameterJdbcTemplate jdbc) { return new JdbcPaymentRepository(jdbc); }
    @Bean JdbcPaymentOrderRepository paymentOrderRepository(NamedParameterJdbcTemplate jdbc) { return new JdbcPaymentOrderRepository(jdbc); }
    @Bean JdbcPlatformPayments platformPayments(@Qualifier("platform") NamedParameterJdbcTemplate platformJdbc) { return new JdbcPlatformPayments(platformJdbc); }

    @Bean LedgerPoster ledgerPoster(NamedParameterJdbcTemplate jdbc, CosProperties p) { return new LedgerPoster(new JdbcJournalWriter(jdbc), ZoneId.of(p.web().timeZone())); }
    @Bean DomainEventHandler<?> ledgerOnDueRaised(LedgerPoster l) { return l.handlers().get(0); }
    @Bean DomainEventHandler<?> ledgerOnDueCancelled(LedgerPoster l) { return l.handlers().get(1); }
    @Bean DomainEventHandler<?> ledgerOnDueWaived(LedgerPoster l) { return l.handlers().get(2); }
    @Bean DomainEventHandler<?> ledgerOnPayment(LedgerPoster l) { return l.handlers().get(3); }

    @Bean DueService dueService(JdbcDueRepository dues, JdbcBillingLookups lookups, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        return new DueService(dues, lookups, lookups, events, audit, tx, clock);
    }

    /** Development provider; only exists when cos.payments.simulated.enabled=true, and never in prod. */
    @Bean @ConditionalOnProperty(name = "cos.payments.simulated.enabled", havingValue = "true")
    SimulatedGateway simulatedGateway(CosProperties p, Environment env) {
        if (env.matchesProfiles("prod")) throw new IllegalStateException("the simulated payment provider cannot be enabled in prod");
        String secret = p.payments().simulated() == null ? null : p.payments().simulated().secret();
        return new SimulatedGateway(secret == null || secret.isBlank() ? "dev-simulated-secret" : secret);
    }

    @Bean GatewayRegistry gatewayRegistry(CosProperties p, Optional<SimulatedGateway> simulated, HttpTransport http, ObjectMapper json, Clock clock) {
        List<PaymentGateway> gateways = new ArrayList<>();
        simulated.ifPresent(gateways::add);
        CosProperties.Razorpay rz = p.payments().razorpay();
        if (rz != null && rz.enabled()) {
            Resilient r = new Resilient(Duration.ofSeconds(8), new CircuitBreaker("razorpay", 5, Duration.ofSeconds(30), clock), RetryPolicy.transientFailures(3));
            gateways.add(new RazorpayGateway(http, r, new RazorpayGateway.Settings(URI.create(rz.baseUrl()), rz.keyId(), rz.keySecret(), rz.webhookSecret()), json));
        }
        return new GatewayRegistry(gateways, p.payments().defaultProvider());
    }

    @Bean GatewaySettlement gatewaySettlement(JdbcDueRepository dues, JdbcPaymentRepository payments, DomainEvents events, AuditWriter audit, Tx tx,
                                              JdbcPaymentOrderRepository orders, Clock clock) {
        return new GatewaySettlement(dues, payments, events, audit, tx, orders, clock);
    }
    @Bean CounterSettlement counterSettlement(JdbcDueRepository dues, JdbcPaymentRepository payments, DomainEvents events, AuditWriter audit, Tx tx,
                                              JdbcBillingLookups lookups, Clock clock) {
        return new CounterSettlement(dues, payments, events, audit, tx, lookups, clock);
    }
    @Bean PaymentService paymentService(JdbcDueRepository dues, JdbcPaymentOrderRepository orders, GatewayRegistry gateways, GatewaySettlement settlement,
                                        JdbcPlatformPayments platform, DomainEvents events, Tx tx, Clock clock, CosProperties p) {
        return new PaymentService(dues, orders, gateways, settlement, platform, platform, events, tx, clock, p.payments().orderTtl(), p.payments().currency());
    }
}
