package com.communityos.api.config;

import com.communityos.api.billing.application.PaymentService;
import com.communityos.api.shared.events.OutboxRelay;
import com.communityos.api.shared.integration.WebhookDeliveryWorker;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Background work. Every job is safe to run on several instances at once (rows are claimed with SKIP LOCKED leases, settlement is
 * idempotent), so no leader election is needed; a failure is logged and the next tick tries again.
 */
@Component
public class Jobs {
    private static final Logger log = LoggerFactory.getLogger(Jobs.class);
    private final OutboxRelay outbox; private final WebhookDeliveryWorker webhooks; private final PaymentService payments; private final NamedParameterJdbcTemplate platformJdbc;

    public Jobs(OutboxRelay outbox, WebhookDeliveryWorker webhooks, PaymentService payments, @Qualifier("platform") NamedParameterJdbcTemplate platformJdbc) {
        this.outbox = outbox; this.webhooks = webhooks; this.payments = payments; this.platformJdbc = platformJdbc;
    }

    @Scheduled(fixedDelayString = "${cos.jobs.outbox-delay:2000}")
    public void relayOutbox() { run("outbox", () -> { while (outbox.runOnce(200) == 200) { /* drain a backlog */ } }); }

    @Scheduled(fixedDelayString = "${cos.jobs.webhook-delay:5000}")
    public void deliverWebhooks() { run("webhooks", () -> webhooks.runOnce(100)); }

    @Scheduled(fixedDelayString = "${cos.jobs.reconcile-delay:120000}", initialDelay = 60000)
    public void reconcilePayments() { run("reconcile", () -> payments.reconcile(100)); }

    @Scheduled(cron = "${cos.jobs.purge-cron:0 17 * * * *}")
    public void purge() {
        run("purge", () -> {
            platformJdbc.update("DELETE FROM identity.otp_challenge WHERE expires_at < now() - interval '1 day'", Map.of());
            platformJdbc.update("DELETE FROM identity.auth_attempt WHERE at < now() - interval '1 day'", Map.of());
            platformJdbc.update("DELETE FROM identity.refresh_token WHERE expires_at < now() - interval '7 days'", Map.of());
            platformJdbc.update("DELETE FROM integration.idempotency_key WHERE created_at < now() - interval '1 day'", Map.of());
            platformJdbc.update("DELETE FROM integration.inbound_event WHERE processed_at < now() - interval '30 days'", Map.of());
        });
    }

    private static void run(String name, Runnable r) {
        try { r.run(); } catch (RuntimeException e) { log.warn("job {} failed: {}", name, e.toString()); }
    }
}
