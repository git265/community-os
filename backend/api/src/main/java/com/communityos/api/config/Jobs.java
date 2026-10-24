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
    private final com.communityos.api.comms.adapter.LiveHub live;
    private final com.communityos.api.billing.application.PaymentReconciler recon;
    private final com.communityos.api.billing.application.LateFeeService lateFees;
    private final com.communityos.api.docs.application.FileService files;
    private final java.util.Optional<com.communityos.api.comms.adapter.PushDelivery> pushes;
    private final com.communityos.api.site.application.SiteService site;
    private final com.communityos.api.maintenance.application.TicketService tickets;
    private final com.communityos.api.maintenance.application.PlannedWorksService planned;

    public Jobs(OutboxRelay outbox, WebhookDeliveryWorker webhooks, PaymentService payments, @Qualifier("platform") NamedParameterJdbcTemplate platformJdbc,
                com.communityos.api.gate.application.GateService gate, com.communityos.api.comms.application.BroadcastService notices,
                com.communityos.api.workforce.application.AttendanceService attendance, com.communityos.api.reports.application.ReportService reports,
                java.util.Optional<com.communityos.api.comms.adapter.ChannelDelivery> channels,
                java.util.Optional<com.communityos.api.billing.adapter.gateway.SimulatedGateway> simulatedBank,
                java.util.Optional<com.communityos.api.billing.application.RefundService> refunds, com.communityos.api.comms.adapter.LiveHub live,
                java.util.Optional<com.communityos.api.comms.adapter.PushDelivery> pushes, com.communityos.api.billing.application.PaymentReconciler recon,
                com.communityos.api.billing.application.LateFeeService lateFees, com.communityos.api.docs.application.FileService files,
                com.communityos.api.site.application.SiteService site, com.communityos.api.maintenance.application.TicketService tickets,
                com.communityos.api.maintenance.application.PlannedWorksService planned) {
        this.planned = planned; this.recon = recon; this.lateFees = lateFees; this.files = files; this.site = site; this.tickets = tickets;
        this.channels = channels; this.simulatedBank = simulatedBank; this.refunds = refunds; this.live = live; this.pushes = pushes;
        this.outbox = outbox; this.webhooks = webhooks; this.payments = payments; this.platformJdbc = platformJdbc; this.gate = gate; this.notices = notices; this.attendance = attendance; this.reports = reports;
    }

    /** Communities with a notice scheduled for now or earlier. */
    static final String NOTICES_DUE = "SELECT DISTINCT community_id FROM comms.broadcast WHERE status = 'Scheduled' AND scheduled_for <= now()";
    @Scheduled(fixedDelayString = "${cos.jobs.notices-delay:60000}", initialDelay = 45000)
    public void sendScheduledNotices() {
        perCommunity("notices", NOTICES_DUE, "scheduled notices", (system) -> notices.sendDue(system));
    }

    /** Communities with gate work due: an approval past its wait, or a visit past its expected time. */
    static final String GATE_DUE = """
        SELECT community_id FROM gate.approval WHERE status = 'Pending' AND expires_at < now()
        UNION SELECT community_id FROM gate.visit WHERE state = 'Inside' AND expected_until < now() - interval '5 minutes'""";
    @Scheduled(fixedDelayString = "${cos.jobs.gate-delay:30000}", initialDelay = 30000)
    public void gateSweep() {
        perCommunity("gate", GATE_DUE, "gate sweep", (system) -> gate.sweep(system));
    }

    /** Communities with an attendance session open longer than their longest shift. */
    static final String ATTENDANCE_DUE = """
        SELECT DISTINCT a.community_id FROM workforce.attendance_session a
        LEFT JOIN workforce.attendance_setting s ON s.community_id = a.community_id
        WHERE a.clock_out IS NULL AND a.clock_in < now() - make_interval(mins => CAST(coalesce(s.max_shift_hours, 12) * 60 AS integer))""";
    @Scheduled(fixedDelayString = "${cos.jobs.attendance-delay:600000}", initialDelay = 90000)
    public void closeForgottenAttendance() {
        perCommunity("attendance", ATTENDANCE_DUE, "attendance", (system) -> attendance.closeOverdue(system));
    }

    /** Communities with a device, or with face profiles (whose photos are deleted some days after the person left). */
    static final String SITE_DUE = "SELECT community_id FROM gate.device WHERE status = 'Active' UNION SELECT community_id FROM gate.face_profile";
    @Scheduled(fixedDelayString = "${cos.jobs.site-delay:600000}", initialDelay = 100000)
    public void syncDevices() {
        perCommunity("site devices", SITE_DUE, "device sync", (system) -> site.sync(system));
    }

    /** Communities with a ticket past its SLA date that nobody was told about yet (today in each community's own zone, checked by the service). */
    static final String SLA_DUE = """
        SELECT DISTINCT community_id FROM maintenance.ticket
        WHERE status IN ('Open', 'Assigned', 'In Progress', 'On Hold') AND sla_due_at < current_date + 1
          AND NOT EXISTS (SELECT 1 FROM maintenance.ticket_sla_alert a WHERE a.community_id = ticket.community_id AND a.ticket_id = ticket.id AND a.due_on = ticket.sla_due_at)""";
    @Scheduled(fixedDelayString = "${cos.jobs.sla-delay:900000}", initialDelay = 110000)
    public void alertOverdueTickets() {
        perCommunity("ticket SLA", SLA_DUE, "ticket SLA alerts", (system) -> tickets.alertOverdue(system));
    }

    /** Communities with an active planned-works checklist (each is checked against its own period and due day by the service). */
    /** maintenance tickets to dispatch or remind about: a queue waiting, or work given out (assigned / in progress) */
    static final String DISPATCH_DUE = "SELECT DISTINCT community_id FROM maintenance.ticket WHERE status IN ('Open', 'Assigned', 'In Progress')";
    @Scheduled(fixedDelayString = "${cos.jobs.dispatch-delay:60000}", initialDelay = 50000)
    public void dispatchTickets() {
        perCommunity("ticket dispatch", DISPATCH_DUE, "ticket dispatch", (system) -> tickets.dispatchAll(system));
    }

    static final String PLANNED_DUE = "SELECT DISTINCT community_id FROM maintenance.checklist WHERE active";
    @Scheduled(fixedDelayString = "${cos.jobs.planned-delay:1800000}", initialDelay = 130000)
    public void remindPlannedWorks() {
        perCommunity("planned works", PLANNED_DUE, "planned works reminders", (system) -> planned.remind(system));
    }

    /** Communities with an active report schedule (each one is checked against its own time and day). */
    static final String REPORTS_DUE = "SELECT DISTINCT community_id FROM reports.schedule WHERE active AND report_type <> 'custom'";
    @Scheduled(fixedDelayString = "${cos.jobs.reports-delay:300000}", initialDelay = 120000)
    public void sendScheduledReports() {
        perCommunity("reports", REPORTS_DUE, "scheduled reports", (system) -> reports.runDue(system));
    }

    @Scheduled(fixedDelayString = "${cos.jobs.outbox-delay:2000}")
    public void relayOutbox() { run("outbox", () -> { while (outbox.runOnce(200) == 200) { /* drain a backlog */ } }); }

    /** New notifications to the open apps connected to this instance (one query for all of them). */
    @Scheduled(fixedDelayString = "${cos.jobs.live-delay:2000}", initialDelay = 5000)
    public void liveNotifications() { run("live", live::fanOut); }
    /** A ping now and then keeps the open streams alive through proxies, and drops the ones that have gone. */
    @Scheduled(fixedDelayString = "${cos.jobs.live-heartbeat:25000}", initialDelay = 25000)
    public void liveHeartbeat() { run("live heartbeat", live::heartbeat); }
    /** Web Push to phones and computers, when a provider is configured. */
    @Scheduled(fixedDelayString = "${cos.jobs.push-delay:3000}", initialDelay = 15000)
    public void deliverPushes() { pushes.ifPresent((d) -> run("push", () -> { while (d.runOnce(100) == 100) { /* drain a backlog */ } })); }

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
    public void reconcilePayments() {
        run("reconcile", () -> payments.reconcile(100)); refunds.ifPresent((r) -> run("refunds", () -> r.reconcile(100)));
        perCommunity("money checks", RECON_DUE, "reconciliation", recon::run);
    }
    /** Communities with files that came in while the virus scanner was down. */
    static final String UNSCANNED_DUE = "SELECT DISTINCT community_id FROM docs.file_object WHERE scan_status IN ('Pending', 'Error')";
    @Scheduled(fixedDelayString = "${cos.jobs.rescan-delay:300000}", initialDelay = 60000)
    public void rescanFiles() { perCommunity("virus rescan", UNSCANNED_DUE, "virus scanner", (system) -> files.rescan(system, 50)); }
    /** Communities that asked for late fees to be added automatically: once a day, after midnight. */
    static final String LATE_FEES_DUE = "SELECT community_id FROM finance.finance_setting WHERE late_fee_enabled AND late_fee_auto";
    @Scheduled(cron = "${cos.jobs.late-fees-cron:0 20 0 * * *}", zone = "${cos.web.time-zone:Asia/Kolkata}")
    public void lateFees() { perCommunity("late fees", LATE_FEES_DUE, "late fees", (system) -> lateFees.apply(system, true), com.communityos.api.shared.security.Permission.MANAGE_DUES); }
    /** Communities with money records in the last 90 days (the checks are cheap; quiet communities are skipped). */
    static final String RECON_DUE = """
        SELECT DISTINCT community_id FROM billing.payment WHERE created_at > now() - interval '90 days'
        UNION SELECT DISTINCT community_id FROM billing.gateway_refund WHERE status = 'Pending'""";

    @Scheduled(cron = "${cos.jobs.purge-cron:0 17 * * * *}")
    public void purge() {
        run("purge", () -> {
            platformJdbc.update("DELETE FROM identity.otp_challenge WHERE expires_at < now() - interval '1 day'", Map.of());
            platformJdbc.update("DELETE FROM identity.auth_attempt WHERE at < now() - interval '1 day'", Map.of());
            platformJdbc.update("DELETE FROM identity.refresh_token WHERE expires_at < now() - interval '7 days'", Map.of());
            platformJdbc.update("DELETE FROM integration.idempotency_key WHERE created_at < now() - interval '1 day'", Map.of());
            platformJdbc.update("DELETE FROM integration.inbound_event WHERE processed_at < now() - interval '30 days'", Map.of());
            platformJdbc.update("DELETE FROM comms.push_queue WHERE created_at < now() - interval '7 days'", Map.of());
        });
    }

    /** Each community the query names, as the system, one at a time; one community's failure is logged and the others still run. */
    private void perCommunity(String job, String sql, String who, java.util.function.Function<com.communityos.api.shared.security.Caller, ?> work,
                              com.communityos.api.shared.security.Permission... permissions) {
        run(job, () -> {
            for (java.util.UUID c : platformJdbc.query(sql, Map.of(), (rs, i) -> rs.getObject("community_id", java.util.UUID.class))) {
                var system = com.communityos.api.shared.security.SystemCaller.of(new com.communityos.api.shared.domain.Ids.CommunityId(c), who, permissions);
                try { com.communityos.api.shared.tenancy.CallerHolder.runAs(system, () -> work.apply(system)); }
                catch (RuntimeException e) { log.warn("{} of {} failed: {}", job, c, e.toString()); }
            }
        });
    }
    private static void run(String name, Runnable r) {
        try { r.run(); } catch (RuntimeException e) { log.warn("job {} failed: {}", name, e.toString()); }
    }
}
