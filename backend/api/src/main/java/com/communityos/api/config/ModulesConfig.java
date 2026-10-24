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
import com.communityos.api.maintenance.adapter.JdbcMaintenanceDirectory;
import com.communityos.api.approval.adapter.JdbcApprovalSettings;
import com.communityos.api.approval.application.PlanCodec;
import com.communityos.api.maintenance.adapter.JdbcQuotationRepository;
import com.communityos.api.maintenance.adapter.JdbcTicketRepository;
import com.communityos.api.maintenance.application.FieldStaffService;
import com.communityos.api.maintenance.application.QuotationService;
import com.communityos.api.maintenance.application.TicketService;
import com.communityos.api.maintenance.application.WishVotes;
import com.communityos.api.shared.resource.ResourceRegistry;
import com.communityos.api.shared.resource.ResourceService;
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
        return new UnitService(new JdbcUnitRepository(jdbc, json), custom, audit, tx, new com.communityos.api.property.adapter.JdbcPropertySetup(jdbc, json));
    }
    @Bean com.communityos.api.property.application.UnitPeopleService unitPeopleService(NamedParameterJdbcTemplate jdbc, ObjectMapper json,
            com.communityos.api.identity.application.port.PersonDirectory persons, com.communityos.api.identity.application.port.RefreshTokenStore tokens,
            com.communityos.api.shared.security.CallerLoader callers, AuditWriter audit, Tx tx, java.time.Clock clock, CosProperties p) {
        return new com.communityos.api.property.application.UnitPeopleService(new JdbcUnitRepository(jdbc, json), new com.communityos.api.property.adapter.JdbcUnitPeople(jdbc, json),
            persons, tokens, callers, audit, tx, clock, p.auth().defaultCountryCode());
    }

    // ---- maintenance ----------------------------------------------------------------------------------------------------------------------
    @Bean JdbcMaintenanceDirectory maintenanceDirectory(NamedParameterJdbcTemplate jdbc) { return new JdbcMaintenanceDirectory(jdbc); }
    @Bean PlanCodec planCodec(ObjectMapper json) { return new PlanCodec(json); }
    @Bean JdbcApprovalSettings approvalSettings(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { return new JdbcApprovalSettings(jdbc, json); }
    @Bean JdbcTicketRepository ticketRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { return new JdbcTicketRepository(jdbc, json); }
    @Bean JdbcQuotationRepository quotationRepository(NamedParameterJdbcTemplate jdbc, PlanCodec plans) { return new JdbcQuotationRepository(jdbc, plans); }
    @Bean com.communityos.api.maintenance.application.PlannedWorksService plannedWorksService(NamedParameterJdbcTemplate jdbc, DomainEvents events, Tx tx, Clock clock) {
        return new com.communityos.api.maintenance.application.PlannedWorksService(new com.communityos.api.maintenance.adapter.JdbcPlannedWorkStore(jdbc), events, tx, clock);
    }
    @Bean TicketService ticketService(JdbcTicketRepository repo, JdbcMaintenanceDirectory dir, JdbcQuotationRepository money, NamedParameterJdbcTemplate jdbc, DomainEvents events,
                                      AuditWriter audit, Tx tx, Clock clock) {
        return new TicketService(repo, dir, dir, money, new com.communityos.api.maintenance.adapter.JdbcDispatchStore(jdbc), events, audit, tx, clock);
    }
    @Bean QuotationService quotationService(JdbcTicketRepository repo, JdbcQuotationRepository docs, JdbcApprovalSettings approvals, DomainEvents events, AuditWriter audit,
                                            Tx tx, Clock clock) {
        return new QuotationService(repo, docs, docs, approvals, events, audit, tx, clock);
    }
    @Bean WishVotes wishVotes(NamedParameterJdbcTemplate jdbc, ResourceService resources, ResourceRegistry registry, ObjectMapper json) { return new WishVotes(jdbc, resources, registry, json); }
    @Bean FieldStaffService fieldStaffService(JdbcMaintenanceDirectory dir, AuditWriter audit, Tx tx) { return new FieldStaffService(dir, dir, audit, tx); }

    // ---- amenities ----------------------------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.amenity.application.BookingService bookingService(NamedParameterJdbcTemplate jdbc, ObjectMapper json, com.communityos.api.billing.application.BillingDesk desk,
                                                                               DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.amenity.application.BookingService(new com.communityos.api.amenity.adapter.JdbcBookingRepository(jdbc, json),
            new com.communityos.api.amenity.adapter.JdbcAmenityCatalog(jdbc, json), desk, new com.communityos.api.amenity.application.AmenityLedger(desk, clock), events, audit, tx, clock);
    }

    // ---- gate -------------------------------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.gate.application.GateService gateService(NamedParameterJdbcTemplate jdbc, ObjectMapper json, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.gate.application.GateService(new com.communityos.api.gate.adapter.JdbcGateStore(jdbc), new com.communityos.api.gate.adapter.JdbcGateDirectory(jdbc, json),
            events, audit, tx, clock);
    }

    // ---- notices, notifications, forum ----------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.comms.adapter.JdbcInbox inbox(NamedParameterJdbcTemplate jdbc) { return new com.communityos.api.comms.adapter.JdbcInbox(jdbc); }
    @Bean com.communityos.api.comms.adapter.JdbcCommsStore commsStore(NamedParameterJdbcTemplate jdbc) { return new com.communityos.api.comms.adapter.JdbcCommsStore(jdbc); }
    /** Every domain event becomes inbox rows (and queued channel messages) in the same transaction. */
    @Bean DomainEventHandler<?> notifier(com.communityos.api.comms.adapter.JdbcInbox inbox) { return new com.communityos.api.comms.application.Notifier(inbox, inbox); }
    @Bean com.communityos.api.comms.application.InboxService inboxService(com.communityos.api.comms.adapter.JdbcInbox inbox) { return new com.communityos.api.comms.application.InboxService(inbox); }
    @Bean com.communityos.api.comms.application.BroadcastService broadcastService(com.communityos.api.comms.adapter.JdbcCommsStore store, com.communityos.api.comms.adapter.JdbcInbox inbox,
                                                                                 DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.comms.application.BroadcastService(store, inbox, events, audit, tx, clock);
    }
    @Bean com.communityos.api.comms.application.ForumService forumService(com.communityos.api.comms.adapter.JdbcCommsStore store, com.communityos.api.comms.adapter.JdbcInbox inbox,
                                                                         DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        return new com.communityos.api.comms.application.ForumService(store, inbox, events, audit, tx, clock);
    }

    // ---- documents and files ----------------------------------------------------------------------------------------------------------------------
    /** Files and documents need each other (a document's file is read by the document's rules), so they are made together. */
    public record Docs(com.communityos.api.docs.application.FileService files, com.communityos.api.docs.application.DocumentService documents) {}
    @Bean Docs docs(NamedParameterJdbcTemplate jdbc, AuditWriter audit, Tx tx, Clock clock, CosProperties p, Environment env, TicketService tickets, QuotationService quotations,
                    com.communityos.api.amenity.application.BookingService bookings, com.communityos.api.cultural.adapter.JdbcCulturalStore cultural,
                    com.communityos.api.governance.application.MeetingService meetings) {
        if (!"clamav".equals(p.files().scanner()) && Deployment.strict(env))
            throw new IllegalStateException("uploaded files must be virus-scanned: set cos.files.scanner=clamav (COS_FILES_SCANNER) and run ClamAV's clamd (COS_FILES_CLAMAV_HOST / _PORT)");
        var repo = new com.communityos.api.docs.adapter.JdbcFileRepository(jdbc);
        var files = new com.communityos.api.docs.application.FileService(repo, new com.communityos.api.docs.adapter.LocalDiskStorage(java.nio.file.Path.of(p.files().dir())),
            switch (p.files().scanner()) {
                case "clamav" -> new com.communityos.api.docs.adapter.ClamAvScanner(p.files().clamavHost(), p.files().clamavPort(), p.files().clamavTimeout());
                case "simulated" -> new com.communityos.api.docs.adapter.SimulatedVirusScanner();
                case "none" -> com.communityos.api.docs.application.port.VirusScanner.NONE;
                default -> throw new IllegalStateException("cos.files.scanner is clamav, simulated or none");
            },
            audit, tx, clock);
        var documents = new com.communityos.api.docs.application.DocumentService(new com.communityos.api.docs.adapter.JdbcDocumentRepository(jdbc), files, audit, tx);
        FileKinds.register(files, repo, tickets, quotations, bookings, documents);
        FileKinds.registerCultural(files, cultural);
        FileKinds.registerGovernance(files, meetings);
        FileKinds.registerVendors(files, jdbc);
        FileKinds.registerAssets(files, jdbc);
        FileKinds.registerPlanned(files, jdbc);
        FileKinds.registerReleases(files, jdbc);
        FileKinds.registerUtilities(files, jdbc);
        return new Docs(files, documents);
    }
    @Bean com.communityos.api.docs.application.FileService fileService(Docs d) { return d.files(); }
    @Bean com.communityos.api.docs.application.DocumentService documentService(Docs d) { return d.documents(); }

    // ---- cultural events and donations ---------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.cultural.adapter.JdbcCulturalStore culturalStore(NamedParameterJdbcTemplate jdbc, PlanCodec plans, ObjectMapper json) {
        return new com.communityos.api.cultural.adapter.JdbcCulturalStore(jdbc, plans, json);
    }
    @Bean com.communityos.api.cultural.application.DonationService donationService(com.communityos.api.cultural.adapter.JdbcCulturalStore store,
                                                                                 com.communityos.api.billing.application.BillingDesk desk, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.cultural.application.DonationService(store, desk, events, audit, tx, clock);
    }
    @Bean com.communityos.api.cultural.application.ExpenseService culturalExpenseService(com.communityos.api.cultural.adapter.JdbcCulturalStore store, JdbcApprovalSettings approvals,
                                                                                       com.communityos.api.billing.application.BillingDesk desk, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.cultural.application.ExpenseService(store, approvals, desk, events, audit, tx, clock);
    }
    @Bean com.communityos.api.cultural.application.SignupService signupService(com.communityos.api.cultural.adapter.JdbcCulturalStore store, AuditWriter audit, Tx tx) {
        return new com.communityos.api.cultural.application.SignupService(store, audit, tx);
    }

    // ---- finance beyond bills --------------------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.finance.adapter.JdbcFinanceStore financeStore(NamedParameterJdbcTemplate jdbc, PlanCodec plans) { return new com.communityos.api.finance.adapter.JdbcFinanceStore(jdbc, plans); }
    @Bean com.communityos.api.finance.application.CashBookService cashBookService(com.communityos.api.finance.adapter.JdbcFinanceStore store, com.communityos.api.billing.application.BillingDesk desk,
                                                                                 AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.finance.application.CashBookService(store, desk, audit, tx, clock);
    }
    @Bean com.communityos.api.finance.application.ReleaseService releaseService(com.communityos.api.finance.adapter.JdbcFinanceStore store, JdbcQuotationRepository money, JdbcApprovalSettings approvals,
                                                                               com.communityos.api.finance.application.CashBookService cash, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.finance.application.ReleaseService(store, money, approvals, cash, events, audit, tx, clock);
    }
    @Bean com.communityos.api.finance.application.PayRequestService payRequestService(com.communityos.api.finance.adapter.JdbcFinanceStore store, com.communityos.api.finance.application.CashBookService cash,
                                                                                     JdbcApprovalSettings approvals, ObjectMapper json, AuditWriter audit, Tx tx) {
        return new com.communityos.api.finance.application.PayRequestService(store, cash, approvals, json, audit, tx);
    }
    @Bean com.communityos.api.finance.application.BankService bankService(com.communityos.api.finance.adapter.JdbcFinanceStore store, AuditWriter audit, Tx tx) {
        return new com.communityos.api.finance.application.BankService(store, audit, tx);
    }
    @Bean com.communityos.api.finance.application.PayoutService payoutService(NamedParameterJdbcTemplate jdbc, com.communityos.api.finance.adapter.JdbcFinanceStore store,
                                                                             com.communityos.api.finance.application.CashBookService cash, com.communityos.api.finance.application.BankService bank,
                                                                             AuditWriter audit, Tx tx) {
        return new com.communityos.api.finance.application.PayoutService(new com.communityos.api.finance.adapter.JdbcPayoutStore(jdbc), store, cash, bank, audit, tx);
    }

    // ---- governance: meetings and e-voting -----------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.governance.adapter.JdbcGovernanceStore governanceStore(NamedParameterJdbcTemplate jdbc, ObjectMapper json) {
        return new com.communityos.api.governance.adapter.JdbcGovernanceStore(jdbc, json);
    }
    @Bean com.communityos.api.governance.application.MeetingService meetingService(com.communityos.api.governance.adapter.JdbcGovernanceStore store, DomainEvents events,
                                                                                 AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.governance.application.MeetingService(store, events, audit, tx, clock);
    }
    @Bean com.communityos.api.governance.application.BallotService ballotService(com.communityos.api.governance.adapter.JdbcGovernanceStore store, DomainEvents events,
                                                                               AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.governance.application.BallotService(store, events, audit, tx, clock);
    }
    /** Voting codes go the way sign-in codes go (the same sender and pepper); only where codes are written to the log (never prod) is the code also shown on screen. */
    @Bean com.communityos.api.governance.application.VoteService voteService(com.communityos.api.governance.adapter.JdbcGovernanceStore store,
                                                                           com.communityos.api.identity.application.port.OtpSender sender, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.governance.application.VoteService(store, new com.communityos.api.identity.application.CodeHasher(p.auth().otpPepper()), sender,
            "log".equals(p.auth().otpSender()), p.auth().defaultCountryCode(), audit, tx, clock);
    }

    // ---- vendors: the service directory -----------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.vendor.application.DirectoryService directoryService(NamedParameterJdbcTemplate jdbc, AuditWriter audit, Tx tx) {
        return new com.communityos.api.vendor.application.DirectoryService(new com.communityos.api.vendor.adapter.JdbcDirectoryStore(jdbc), audit, tx);
    }

    // ---- assets: stock and condition ------------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.assets.application.AssetService assetService(NamedParameterJdbcTemplate jdbc, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.assets.application.AssetService(new com.communityos.api.assets.adapter.JdbcAssetStore(jdbc), events, audit, tx, clock);
    }

    // ---- workforce: attendance -------------------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.workforce.application.AttendanceService attendanceService(NamedParameterJdbcTemplate jdbc, ObjectMapper json, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.workforce.application.AttendanceService(new com.communityos.api.workforce.adapter.JdbcAttendanceStore(jdbc, json), audit, tx, clock);
    }

    // ---- site devices: bridges, terminals, the punch ledger --------------------------------------------------------------------------------------
    @Bean com.communityos.api.site.application.SiteService siteService(NamedParameterJdbcTemplate jdbc, @org.springframework.beans.factory.annotation.Qualifier("platform") NamedParameterJdbcTemplate platformJdbc,
                                                                       com.communityos.api.gate.application.GateService gate, com.communityos.api.workforce.application.AttendanceService attendance,
                                                                       AuditWriter audit, Tx tx, Clock clock) {
        return new com.communityos.api.site.application.SiteService(new com.communityos.api.site.adapter.JdbcSiteStore(jdbc), new com.communityos.api.site.adapter.JdbcBridgeDirectory(platformJdbc),
            gate, attendance, audit, tx, clock);
    }

    // ---- reports ----------------------------------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.reports.application.ReportService reportService(NamedParameterJdbcTemplate jdbc, com.communityos.api.comms.adapter.JdbcInbox inbox, ObjectMapper json,
                                                                            AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.reports.application.ReportService(new com.communityos.api.reports.adapter.JdbcReportData(jdbc), inbox, json, audit, tx, clock);
    }

    // ---- billing ------------------------------------------------------------------------------------------------------------------------------
    @Bean JdbcDueRepository dueRepository(NamedParameterJdbcTemplate jdbc) { return new JdbcDueRepository(jdbc); }
    @Bean JdbcBillingLookups billingLookups(NamedParameterJdbcTemplate jdbc) { return new JdbcBillingLookups(jdbc); }
    @Bean JdbcPaymentRepository paymentRepository(NamedParameterJdbcTemplate jdbc) { return new JdbcPaymentRepository(jdbc); }
    @Bean JdbcPaymentOrderRepository paymentOrderRepository(NamedParameterJdbcTemplate jdbc) { return new JdbcPaymentOrderRepository(jdbc); }
    @Bean JdbcPlatformPayments platformPayments(@Qualifier("platform") NamedParameterJdbcTemplate platformJdbc) { return new JdbcPlatformPayments(platformJdbc); }

    @Bean LedgerPoster ledgerPoster(NamedParameterJdbcTemplate jdbc, Clock clock) { return new LedgerPoster(new JdbcJournalWriter(jdbc), clock); }
    @Bean DomainEventHandler<?> ledgerOnDueRaised(LedgerPoster l) { return l.handlers().get(0); }
    @Bean DomainEventHandler<?> ledgerOnDueCancelled(LedgerPoster l) { return l.handlers().get(1); }
    @Bean DomainEventHandler<?> ledgerOnDueWaived(LedgerPoster l) { return l.handlers().get(2); }
    @Bean DomainEventHandler<?> ledgerOnPayment(LedgerPoster l) { return l.handlers().get(3); }
    @Bean DomainEventHandler<?> ledgerOnCreditApplied(LedgerPoster l) { return l.handlers().get(4); }
    @Bean com.communityos.api.billing.application.TargetSettlement targetSettlement(JdbcDueRepository dues, JdbcPaymentRepository payments, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        return new com.communityos.api.billing.application.TargetSettlement(dues, payments, events, audit, tx, clock);
    }
    @Bean com.communityos.api.billing.application.BillingDesk billingDesk(JdbcPaymentRepository payments, com.communityos.api.billing.application.TargetSettlement counter,
                                                                          NamedParameterJdbcTemplate jdbc, DomainEvents events, Clock clock) {
        return new com.communityos.api.billing.application.BillingDesk(payments, counter, new JdbcJournalWriter(jdbc), events, clock);
    }

    @Bean DueService dueService(JdbcDueRepository dues, JdbcBillingLookups lookups, DomainEvents events, AuditWriter audit, Tx tx, Clock clock,
                                com.communityos.api.billing.application.BillingDesk desk) {
        return new DueService(dues, lookups, lookups, events, audit, tx, clock).credits(desk);
    }
    @Bean com.communityos.api.billing.application.LateFeeService lateFeeService(NamedParameterJdbcTemplate jdbc, ObjectMapper json, DueService dues, Tx tx, Clock clock) {
        return new com.communityos.api.billing.application.LateFeeService(new com.communityos.api.billing.adapter.JdbcLateFeeStore(jdbc, json), dues, tx, clock);
    }
    @Bean com.communityos.api.billing.application.ReadingPublisher readingPublisher(NamedParameterJdbcTemplate jdbc, DueService dues, AuditWriter audit, Tx tx, Clock clock) {
        return new com.communityos.api.billing.application.ReadingPublisher(new com.communityos.api.billing.adapter.JdbcReadingStore(jdbc), dues, audit, tx, clock);
    }

    @Bean com.communityos.api.auditlog.AuditLog auditLog(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { return new com.communityos.api.auditlog.AuditLog(jdbc, json); }

    // ---- push: the live stream to open apps, Web Push to closed ones ------------------------------------------------------------------------------
    @Bean com.communityos.api.comms.adapter.LiveHub liveHub(@org.springframework.beans.factory.annotation.Qualifier("platform") NamedParameterJdbcTemplate platformJdbc, Clock clock) {
        return new com.communityos.api.comms.adapter.LiveHub(platformJdbc, clock);
    }
    @Bean Optional<com.communityos.api.comms.application.port.PushSender> pushSender(CosProperties p, Environment env, HttpTransport http, ObjectMapper json, Clock clock) {
        CosProperties.Push push = p.push();
        switch (push.provider()) {
            case "webpush" -> {
                com.communityos.api.shared.push.WebPush.Vapid v;
                if (push.vapidPublicKey() == null || push.vapidPublicKey().isBlank() || push.vapidPrivateKey() == null || push.vapidPrivateKey().isBlank()) {
                    if (Deployment.strict(env)) throw new IllegalStateException("cos.push.vapid-public-key and vapid-private-key are required for Web Push in prod");
                    v = com.communityos.api.shared.push.WebPush.generate();   // development: a key pair for this run (browsers subscribe again after a restart)
                    org.slf4j.LoggerFactory.getLogger(ModulesConfig.class).warn("Web Push: no VAPID keys configured - made a pair for this run. To keep subscriptions across restarts set "
                        + "COS_PUSH_VAPID_PUBLIC_KEY={} and COS_PUSH_VAPID_PRIVATE_KEY={}", v.publicKeyB64(), v.privateKeyB64());
                } else v = com.communityos.api.shared.push.WebPush.of(push.vapidPublicKey(), push.vapidPrivateKey());
                return Optional.of(new com.communityos.api.comms.adapter.WebPushSender(http, v, push.subject(), json, clock));
            }
            case "log" -> {
                if (Deployment.strict(env)) throw new IllegalStateException("cos.push.provider=log cannot be used in prod");
                return Optional.of(new com.communityos.api.comms.adapter.LogPushSender());
            }
            default -> { return Optional.empty(); }
        }
    }
    @Bean com.communityos.api.comms.application.PushService pushService(NamedParameterJdbcTemplate jdbc, Optional<com.communityos.api.comms.application.port.PushSender> sender) {
        return new com.communityos.api.comms.application.PushService(jdbc, sender.orElse(null));
    }
    @Bean Optional<com.communityos.api.comms.adapter.PushDelivery> pushDelivery(@org.springframework.beans.factory.annotation.Qualifier("platform") NamedParameterJdbcTemplate platformJdbc,
                                                                               Optional<com.communityos.api.comms.application.port.PushSender> sender) {
        return sender.map((s) -> new com.communityos.api.comms.adapter.PushDelivery(platformJdbc, s));
    }

    /** The WhatsApp / SMS / e-mail copies of notifications: delivered by the configured provider (cos.channels.provider), or not at all. */
    @Bean @ConditionalOnProperty(name = "cos.channels.provider", havingValue = "simulated")
    com.communityos.api.comms.adapter.ChannelDelivery channelDelivery(@org.springframework.beans.factory.annotation.Qualifier("platform") NamedParameterJdbcTemplate platformJdbc, Environment env) {
        if (Deployment.strict(env)) throw new IllegalStateException("the simulated message provider cannot be used in prod");
        return new com.communityos.api.comms.adapter.ChannelDelivery(platformJdbc, new com.communityos.api.comms.adapter.SimulatedChannelSender());
    }

    /** Development provider; only exists when cos.payments.simulated.enabled=true, and never in prod. */
    @Bean @ConditionalOnProperty(name = "cos.payments.simulated.enabled", havingValue = "true")
    SimulatedGateway simulatedGateway(CosProperties p, Environment env, Clock clock) {
        if (Deployment.strict(env)) throw new IllegalStateException("the simulated payment provider cannot be enabled in prod");
        CosProperties.Simulated sim = p.payments().simulated();
        String secret = sim == null ? null : sim.secret();
        var d = sim == null ? SimulatedGateway.Delays.DEFAULT : new SimulatedGateway.Delays(sim.pendingDelay(), sim.lostDelay(), sim.refundDelay(), sim.slowLatency());
        // the same protection the server puts around Razorpay: a time-out per call, retries of what may pass next time, a circuit breaker
        Resilient r = new Resilient(sim == null ? Duration.ofSeconds(8) : sim.timeout(), new CircuitBreaker("simulated payments", 5, Duration.ofSeconds(30), clock), RetryPolicy.transientFailures(3));
        SimulatedGateway g = new SimulatedGateway(secret == null || secret.isBlank() ? "dev-simulated-secret" : secret, clock, d, r);
        if (sim != null) g.mode(new SimulatedGateway.Mode(SimulatedGateway.Service.valueOf(sim.service().toUpperCase(java.util.Locale.ROOT)), sim.refundsFail()));
        return g;
    }

    @Bean GatewayRegistry gatewayRegistry(CosProperties p, Optional<SimulatedGateway> simulated, HttpTransport http, ObjectMapper json, Clock clock) {
        List<PaymentGateway> gateways = new ArrayList<>();
        simulated.ifPresent(gateways::add);
        CosProperties.Razorpay rz = p.payments().razorpay();
        if (rz != null && rz.enabled()) {
            if (blank(rz.keyId()) || blank(rz.keySecret()) || blank(rz.webhookSecret()) || rz.webhookSecret().length() < 16)
                throw new IllegalStateException("Razorpay is enabled: cos.payments.razorpay.key-id, key-secret and webhook-secret (16+ characters) are required");
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
    @Bean PaymentService paymentService(JdbcDueRepository dues, JdbcPaymentRepository payments, JdbcPaymentOrderRepository orders, GatewayRegistry gateways, GatewaySettlement settlement,
                                        JdbcPlatformPayments platform, DomainEvents events, Tx tx, Clock clock, CosProperties p) {
        return new PaymentService(dues, payments, orders, gateways, settlement, platform, platform, events, tx, clock, p.payments().orderTtl(), p.payments().currency());
    }
    @Bean com.communityos.api.summary.SummaryService summaryService(NamedParameterJdbcTemplate jdbc, Clock clock, CosProperties p) {
        return new com.communityos.api.summary.SummaryService(jdbc, clock);
    }
    /** Refunds through the payment provider: the payment webhook passes refund news on; a booking's fee and deposit refunds use it. */
    @Bean com.communityos.api.billing.application.RefundService refundService(NamedParameterJdbcTemplate jdbc, @Qualifier("platform") NamedParameterJdbcTemplate platformJdbc,
                                                                             GatewayRegistry gateways, AuditWriter audit, Tx tx, Clock clock, PaymentService payments,
                                                                             com.communityos.api.amenity.application.BookingService bookings) {
        var refunds = new com.communityos.api.billing.application.RefundService(new com.communityos.api.billing.adapter.JdbcRefunds(jdbc, platformJdbc), new com.communityos.api.billing.adapter.JdbcRefunds(jdbc, platformJdbc),
            gateways, audit, tx, clock);
        payments.refunds(refunds);
        bookings.refunds(refunds);
        return refunds;
    }
    /** Reconciliation of the money records (and money the provider captured on closed orders, found by the payment job). */
    @Bean com.communityos.api.billing.application.PaymentReconciler paymentReconciler(NamedParameterJdbcTemplate jdbc, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, PaymentService payments) {
        var r = new com.communityos.api.billing.application.PaymentReconciler(new com.communityos.api.billing.adapter.JdbcReconStore(jdbc), events, audit, tx, clock);
        payments.reconciler(r);
        return r;
    }
    private static boolean blank(String s) { return s == null || s.isBlank(); }
}
