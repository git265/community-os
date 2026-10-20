package com.communityos.config;

import com.communityos.idempotency.IdempotencyStore;
import com.communityos.idempotency.InMemoryIdempotencyStore;
import com.communityos.idempotency.JdbcIdempotencyStore;
import com.communityos.outbox.EventOutboxStore;
import com.communityos.outbox.InMemoryEventOutboxStore;
import com.communityos.outbox.JdbcEventOutboxStore;
import com.communityos.payments.BookingClaims;
import com.communityos.payments.BookingPaymentClaims;
import com.communityos.payments.CircuitBreaker;
import com.communityos.payments.FinanceSettlement;
import com.communityos.payments.InMemoryPaymentStore;
import com.communityos.payments.JdbcPaymentStore;
import com.communityos.payments.PaymentStore;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.service.Tx;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The money-side beans: where orders, idempotency keys and outbox events are kept (the same database as the records, chosen by
 * app.storage.provider), the settlement steps, and the circuit breaker around the payment provider.
 */
@Configuration
public class PaymentsConfig {

    private static boolean memory(AppProperties p) { return "memory".equals(p.storage().provider()); }

    @Bean
    PaymentStore paymentStore(AppProperties p, ObjectProvider<JdbcTemplate> jdbc, ObjectMapper json, Clock clock) {
        return memory(p) ? new InMemoryPaymentStore(clock) : new JdbcPaymentStore(jdbc.getObject(), json);
    }

    @Bean
    IdempotencyStore idempotencyStore(AppProperties p, ObjectProvider<JdbcTemplate> jdbc, Clock clock) {
        return memory(p) ? new InMemoryIdempotencyStore(clock) : new JdbcIdempotencyStore(jdbc.getObject());
    }

    @Bean
    EventOutboxStore eventOutboxStore(AppProperties p, ObjectProvider<JdbcTemplate> jdbc, ObjectMapper json, Clock clock) {
        return memory(p) ? new InMemoryEventOutboxStore(clock) : new JdbcEventOutboxStore(jdbc.getObject(), json);
    }

    /** What an amenity booking paid online takes hold of: the one real, unused payment it was paid with. */
    @Bean
    BookingClaims bookingClaims(PaymentStore store, Tx tx) { return new BookingPaymentClaims(store, tx); }

    @Bean
    FinanceSettlement financeSettlement(DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, Constants constants) {
        return new FinanceSettlement(repo, audit, json, clock, constants);
    }

    /** One breaker for every call to the provider: when it is down, all requests find out at once instead of each waiting for a timeout. */
    @Bean
    CircuitBreaker providerBreaker(AppProperties p) {
        AppProperties.Payments c = p.payments();
        if (!c.allowSimulated()) {   // production: no pretend bank, no default secret
            if ("simulated".equals(c.provider())) throw new IllegalStateException("app.payments.provider=simulated is not allowed when app.payments.allow-simulated=false.");
            if (c.webhookSecret() == null || c.webhookSecret().isBlank() || "dev-secret".equals(c.webhookSecret())) throw new IllegalStateException("Set PAYMENT_WEBHOOK_SECRET.");
        }
        return new CircuitBreaker("payment provider", c.breakerTimeoutMs(), c.breakerFailures(), c.breakerResetMs());
    }
}
