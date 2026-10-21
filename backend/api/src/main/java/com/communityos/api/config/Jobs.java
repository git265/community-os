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
    private final com.communityos.api.gate.application.GateService gate; private final com.communityos.api.comms.application.BroadcastService notices;
    private final com.communityos.api.workforce.application.AttendanceService attendance; private final com.communityos.api.reports.application.ReportService reports;
    private final java.util.Optional<com.communityos.api.comms.adapter.ChannelDelivery> channels;
    private final java.util.Optional<com.communityos.api.billing.adapter.gateway.SimulatedGateway> simulatedBank;
    private final java.util.Optional<com.communityos.api.billing.application.RefundService> refunds;

    public Jobs(OutboxRelay outbox, WebhookDeliveryWorker webhooks, PaymentService payments, @Qualifier("platform") NamedParameterJdbcTemplate platformJdbc,
                com.communityos.api.gate.application.GateService gate, com.communityos.api.comms.application.BroadcastService notices,
                com.communityos.api.workforce.application.AttendanceService attendance, com.communityos.api.reports.application.ReportService reports,
                java.util.Optional<com.communityos.api.comms.adapter.ChannelDelivery> channels,
                java.util.Optional<com.communityos.api.billing.adapter.gateway.SimulatedGateway> simulatedBank,
                java.util.Optional<com.communityos.api.billing.application.RefundService> refunds) {
        this.channels = channels; this.simulatedBank = simulatedBank; this.refunds = refunds;
        this.outbox = outbox; this.webhooks = webhooks; this.payments = payments; this.platformJdbc = platformJdbc; this.gate = gate; this.notices = notices; this.attendance = attendance; this.reports = reports;
    }

    /** Communities with a notice scheduled for now or earlier. */
    static final String NOTICES_DUE = "SELECT DISTINCT community_id FROM comms.broadcast WHERE status = 'Scheduled' AND scheduled_for <= now()";
    @Scheduled(fixedDelayString = "${cos.jobs.notices-delay:60000}", initialDelay = 45000)
    public void sendScheduledNotices() {
        run("notices", () -> {
            for (java.util.UUID c : platformJdbc.query(NOTICES_DUE, Map.of(), (rs, i) -> rs.getObject("community_id", java.util.UUID.class))) {
                var system = com.communityos.api.shared.security.SystemCaller.of(new com.communityos.api.shared.domain.Ids.CommunityId(c), "scheduled notices");
                try { com.communityos.api.shared.tenancy.CallerHolder.runAs(system, () -> notices.sendDue(system)); }
                catch (RuntimeException e) { log.warn("scheduled notices of {} failed: {}", c, e.toString()); }
            }
        });
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

    /** Communities with an attendance session open longer than their longest shift. */
    static final String ATTENDANCE_DUE = """
        SELECT DISTINCT a.community_id FROM workforce.attendance_session a
        LEFT JOIN workforce.attendance_setting s ON s.community_id = a.community_id
        WHERE a.clock_out IS NULL AND a.clock_in < now() - make_interval(mins => CAST(coalesce(s.max_shift_hours, 12) * 60 AS integer))""";
    @Scheduled(fixedDelayString = "${cos.jobs.attendance-delay:600000}", initialDelay = 90000)
    public void closeForgottenAttendance() {
        run("attendance", () -> {
            for (java.util.UUID c : platformJdbc.query(ATTENDANCE_DUE, Map.of(), (rs, i) -> rs.getObject("community_id", java.util.UUID.class))) {
                var system = com.communityos.api.shared.security.SystemCaller.of(new com.communityos.api.shared.domain.Ids.CommunityId(c), "attendance");
                try { com.communityos.api.shared.tenancy.CallerHolder.runAs(system, () -> attendance.closeOverdue(system)); }
                catch (RuntimeException e) { log.warn("closing attendance of {} failed: {}", c, e.toString()); }
            }
        });
    }

    /** Communities with an active report schedule (each one is checked against its own time and day). */
    static final String REPORTS_DUE = "SELECT DISTINCT community_id FROM reports.schedule WHERE active AND report_type <> 'custom'";
    @Scheduled(fixedDelayString = "${cos.jobs.reports-delay:300000}", initialDelay = 120000)
    public void sendScheduledReports() {
        run("reports", () -> {
            for (java.util.UUID c : platformJdbc.query(REPORTS_DUE, Map.of(), (rs, i) -> rs.getObject("community_id", java.util.UUID.class))) {
                var system = com.communityos.api.shared.security.SystemCaller.of(new com.communityos.api.shared.domain.Ids.CommunityId(c), "scheduled reports");
                try { com.communityos.api.shared.tenancy.CallerHolder.runAs(system, () -> reports.runDue(system)); }
                catch (RuntimeException e) { log.warn("scheduled reports of {} failed: {}", c, e.toString()); }
            }
        });
    }

    @Scheduled(fixedDelayString = "${cos.jobs.outbox-delay:2000}")
    public void relayOutbox() { run("outbox", () -> { while (outbox.runOnce(200) == 200) { /* drain a backlog */ } }); }

    /** The WhatsApp / SMS / e-mail copies of notifications, when a provider is configured (otherwise they stay Queued). */
    @Scheduled(fixedDelayString = "${cos.jobs.channels-delay:10000}", initialDelay = 20000)
    public void deliverChannelMessages() { channels.ifPresent((d) -> run("channels", () -> { while (d.runOnce(100) == 100) { /* drain a backlog */ } })); }

    @Scheduled(fixedDelayString = "${cos.jobs.webhook-delay:5000}")
    public void deliverWebhooks() { run("webhooks", () -> webhooks.runOnce(100)); }

    /** Development only: the simulated provider's webhooks (a declined card, a slow bank that charges later, a confirmation the app never sent). */
    @Scheduled(fixedDelayString = "${cos.jobs.simulated-bank-delay:3000}", initialDelay = 10000)
    public void simulatedBankWebhooks() {
        simulatedBank.ifPresent((g) -> run("simulated bank", () -> {
            for (var h : g.dueWebhooks()) {
                try { payments.webhook("simulated", h.getKey(), h.getValue()); }
                catch (RuntimeException e) { log.warn("simulated webhook failed: {}", e.toString()); }
            }
        }));
    }

    @Scheduled(fixedDelayString = "${cos.jobs.reconcile-delay:120000}", initialDelay = 60000)
    public void reconcilePayments() { run("reconcile", () -> payments.reconcile(100)); refunds.ifPresent((r) -> run("refunds", () -> r.reconcile(100))); }

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
