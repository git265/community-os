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
    private final com.communityos.api.gate.application.GateService gate;

    public Jobs(OutboxRelay outbox, WebhookDeliveryWorker webhooks, PaymentService payments, @Qualifier("platform") NamedParameterJdbcTemplate platformJdbc,
                com.communityos.api.gate.application.GateService gate) {
        this.outbox = outbox; this.webhooks = webhooks; this.payments = payments; this.platformJdbc = platformJdbc; this.gate = gate;
    }

    /** Communities with gate work due: an approval past its wait, or a visit past its expected time. */
    static final String GATE_DUE = """
        SELECT community_id FROM gate.approval WHERE status = 'Pending' AND expires_at < now()
        UNION SELECT community_id FROM gate.visit WHERE state = 'Inside' AND expected_until < now() - interval '5 minutes'""";
    @Scheduled(fixedDelayString = "${cos.jobs.gate-delay:30000}", initialDelay = 30000)
    public void gateSweep() {
        run("gate", () -> {
            for (java.util.UUID c : platformJdbc.query(GATE_DUE, Map.of(), (rs, i) -> rs.getObject("community_id", java.util.UUID.class))) {
                var system = com.communityos.api.shared.security.SystemCaller.of(new com.communityos.api.shared.domain.Ids.CommunityId(c), "gate sweep");
                try { com.communityos.api.shared.tenancy.CallerHolder.runAs(system, () -> gate.sweep(system)); }
                catch (RuntimeException e) { log.warn("gate sweep of {} failed: {}", c, e.toString()); }
            }
        });
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
