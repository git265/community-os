package com.communityos.api.config;

import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.custom.CustomFields;
import com.communityos.api.shared.events.DomainEventHandler;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.events.OutboxRelay;
import com.communityos.api.shared.http.HttpTransport;
import com.communityos.api.shared.http.JdkHttpTransport;
import com.communityos.api.shared.integration.SecretResolver;
import com.communityos.api.shared.integration.WebhookDeliveryWorker;
import com.communityos.api.shared.integration.WebhookFanout;
import com.communityos.api.shared.jdbc.JdbcAuditWriter;
import com.communityos.api.shared.jdbc.JdbcFieldDefinitions;
import com.communityos.api.shared.jdbc.JdbcIdempotencyStore;
import com.communityos.api.shared.jdbc.JdbcOutboxStore;
import com.communityos.api.shared.jdbc.JdbcOutboxWriter;
import com.communityos.api.shared.web.Idempotency;
import com.communityos.api.shared.web.Json;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.ZoneId;
import java.util.List;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The shared kernel's beans: clock, JSON, events (Observer + outbox), audit, idempotency, custom fields, outbound HTTP, webhooks. */
@Configuration
public class CoreConfig {
    @Bean Clock clock(CosProperties p) { return Clock.system(ZoneId.of(p.web().timeZone())); }
    @Bean @Primary ObjectMapper objectMapper() { return Json.mapper(); }

    /** All in-process handlers (the ledger poster's, and any module's) are collected by type. */
    @Bean DomainEvents domainEvents(List<DomainEventHandler<?>> handlers, NamedParameterJdbcTemplate jdbc, ObjectMapper json) {
        return new DomainEvents(handlers, new JdbcOutboxWriter(jdbc, json));
    }
    @Bean AuditWriter auditWriter(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { return new JdbcAuditWriter(jdbc, json); }
    @Bean Idempotency idempotency(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { return new Idempotency(new JdbcIdempotencyStore(jdbc), json); }
    @Bean CustomFields customFields(NamedParameterJdbcTemplate jdbc) { return new CustomFields(new JdbcFieldDefinitions(jdbc)); }
    @Bean HttpTransport httpTransport() { return new JdkHttpTransport(); }

    @Bean OutboxRelay outboxRelay(@Qualifier("platform") NamedParameterJdbcTemplate platformJdbc, Clock clock) {
        return new OutboxRelay(new JdbcOutboxStore(platformJdbc), new WebhookFanout(platformJdbc), 10, clock);
    }
    /** Webhook secrets by reference: COS_SECRET_<REF> in the environment (swap for a secret-manager client in production). */
    @Bean SecretResolver secretResolver(Environment env) {
        return (ref) -> {
            String v = env.getProperty("COS_SECRET_" + ref.toUpperCase().replaceAll("[^A-Z0-9]", "_"));
            if (v == null || v.isBlank()) throw new IllegalStateException("secret " + ref + " is not configured");
            return v;
        };
    }
    @Bean WebhookDeliveryWorker webhookDeliveryWorker(@Qualifier("platform") NamedParameterJdbcTemplate platformJdbc, HttpTransport http, SecretResolver secrets, Clock clock) {
        return new WebhookDeliveryWorker(platformJdbc, http, secrets, clock);
    }
}
