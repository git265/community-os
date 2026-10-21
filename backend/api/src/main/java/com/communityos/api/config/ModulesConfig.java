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
        return new UnitService(new JdbcUnitRepository(jdbc, json), custom, audit, tx);
    }

    // ---- maintenance ----------------------------------------------------------------------------------------------------------------------
    @Bean JdbcMaintenanceDirectory maintenanceDirectory(NamedParameterJdbcTemplate jdbc) { return new JdbcMaintenanceDirectory(jdbc); }
    @Bean PlanCodec planCodec(ObjectMapper json) { return new PlanCodec(json); }
    @Bean JdbcApprovalSettings approvalSettings(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { return new JdbcApprovalSettings(jdbc, json); }
    @Bean JdbcTicketRepository ticketRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { return new JdbcTicketRepository(jdbc, json); }
    @Bean JdbcQuotationRepository quotationRepository(NamedParameterJdbcTemplate jdbc, PlanCodec plans) { return new JdbcQuotationRepository(jdbc, plans); }
    @Bean TicketService ticketService(JdbcTicketRepository repo, JdbcMaintenanceDirectory dir, JdbcQuotationRepository money, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        return new TicketService(repo, dir, dir, money, events, audit, tx, clock);
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
        ZoneId zone = ZoneId.of(p.web().timeZone());
        return new com.communityos.api.amenity.application.BookingService(new com.communityos.api.amenity.adapter.JdbcBookingRepository(jdbc, json),
            new com.communityos.api.amenity.adapter.JdbcAmenityCatalog(jdbc, json), desk, new com.communityos.api.amenity.application.AmenityLedger(desk, zone), events, audit, tx, clock, zone);
    }

    // ---- gate -------------------------------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.gate.application.GateService gateService(NamedParameterJdbcTemplate jdbc, ObjectMapper json, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.gate.application.GateService(new com.communityos.api.gate.adapter.JdbcGateStore(jdbc), new com.communityos.api.gate.adapter.JdbcGateDirectory(jdbc, json),
            events, audit, tx, clock, ZoneId.of(p.web().timeZone()));
    }

    // ---- notices, notifications, forum ----------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.comms.adapter.JdbcInbox inbox(NamedParameterJdbcTemplate jdbc) { return new com.communityos.api.comms.adapter.JdbcInbox(jdbc); }
    @Bean com.communityos.api.comms.adapter.JdbcCommsStore commsStore(NamedParameterJdbcTemplate jdbc) { return new com.communityos.api.comms.adapter.JdbcCommsStore(jdbc); }
    /** Every domain event becomes inbox rows (and queued channel messages) in the same transaction. */
    @Bean DomainEventHandler<?> notifier(com.communityos.api.comms.adapter.JdbcInbox inbox) { return new com.communityos.api.comms.application.Notifier(inbox, inbox); }
    @Bean com.communityos.api.comms.application.InboxService inboxService(com.communityos.api.comms.adapter.JdbcInbox inbox) { return new com.communityos.api.comms.application.InboxService(inbox); }
    @Bean com.communityos.api.comms.application.BroadcastService broadcastService(com.communityos.api.comms.adapter.JdbcCommsStore store, com.communityos.api.comms.adapter.JdbcInbox inbox,
                                                                                 DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.comms.application.BroadcastService(store, inbox, events, audit, tx, clock, ZoneId.of(p.web().timeZone()));
    }
    @Bean com.communityos.api.comms.application.ForumService forumService(com.communityos.api.comms.adapter.JdbcCommsStore store, com.communityos.api.comms.adapter.JdbcInbox inbox,
                                                                         DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        return new com.communityos.api.comms.application.ForumService(store, inbox, events, audit, tx, clock);
    }

    // ---- documents and files ----------------------------------------------------------------------------------------------------------------------
    /** Files and documents need each other (a document's file is read by the document's rules), so they are made together. */
    public record Docs(com.communityos.api.docs.application.FileService files, com.communityos.api.docs.application.DocumentService documents) {}
    @Bean Docs docs(NamedParameterJdbcTemplate jdbc, AuditWriter audit, Tx tx, Clock clock, CosProperties p, TicketService tickets, QuotationService quotations,
                    com.communityos.api.amenity.application.BookingService bookings, com.communityos.api.cultural.adapter.JdbcCulturalStore cultural) {
        var repo = new com.communityos.api.docs.adapter.JdbcFileRepository(jdbc);
        var files = new com.communityos.api.docs.application.FileService(repo, new com.communityos.api.docs.adapter.LocalDiskStorage(java.nio.file.Path.of(p.files().dir())),
            com.communityos.api.docs.application.port.VirusScanner.NONE, audit, tx, clock);
        var documents = new com.communityos.api.docs.application.DocumentService(new com.communityos.api.docs.adapter.JdbcDocumentRepository(jdbc), files, audit, tx);
        FileKinds.register(files, repo, tickets, quotations, bookings, documents);
        FileKinds.registerCultural(files, cultural);
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
        return new com.communityos.api.cultural.application.DonationService(store, desk, events, audit, tx, clock, ZoneId.of(p.web().timeZone()));
    }
    @Bean com.communityos.api.cultural.application.ExpenseService culturalExpenseService(com.communityos.api.cultural.adapter.JdbcCulturalStore store, JdbcApprovalSettings approvals,
                                                                                       com.communityos.api.billing.application.BillingDesk desk, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.cultural.application.ExpenseService(store, approvals, desk, events, audit, tx, clock, ZoneId.of(p.web().timeZone()));
    }
    @Bean com.communityos.api.cultural.application.SignupService signupService(com.communityos.api.cultural.adapter.JdbcCulturalStore store, AuditWriter audit, Tx tx) {
        return new com.communityos.api.cultural.application.SignupService(store, audit, tx);
    }

    // ---- finance beyond bills --------------------------------------------------------------------------------------------------------------------
    @Bean com.communityos.api.finance.adapter.JdbcFinanceStore financeStore(NamedParameterJdbcTemplate jdbc, PlanCodec plans) { return new com.communityos.api.finance.adapter.JdbcFinanceStore(jdbc, plans); }
    @Bean com.communityos.api.finance.application.CashBookService cashBookService(com.communityos.api.finance.adapter.JdbcFinanceStore store, com.communityos.api.billing.application.BillingDesk desk,
                                                                                 AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.finance.application.CashBookService(store, desk, audit, tx, clock, ZoneId.of(p.web().timeZone()));
    }
    @Bean com.communityos.api.finance.application.ReleaseService releaseService(com.communityos.api.finance.adapter.JdbcFinanceStore store, JdbcQuotationRepository money, JdbcApprovalSettings approvals,
                                                                               com.communityos.api.finance.application.CashBookService cash, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new com.communityos.api.finance.application.ReleaseService(store, money, approvals, cash, events, audit, tx, clock, ZoneId.of(p.web().timeZone()));
    }
    @Bean com.communityos.api.finance.application.PayRequestService payRequestService(com.communityos.api.finance.adapter.JdbcFinanceStore store, com.communityos.api.finance.application.CashBookService cash,
                                                                                     JdbcApprovalSettings approvals, ObjectMapper json, AuditWriter audit, Tx tx) {
        return new com.communityos.api.finance.application.PayRequestService(store, cash, approvals, json, audit, tx);
    }
    @Bean com.communityos.api.finance.application.BankService bankService(com.communityos.api.finance.adapter.JdbcFinanceStore store, AuditWriter audit, Tx tx) {
        return new com.communityos.api.finance.application.BankService(store, audit, tx);
    }

    // ---- billing ------------------------------------------------------------------------------------------------------------------------------
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
    @Bean DomainEventHandler<?> ledgerOnCreditApplied(LedgerPoster l) { return l.handlers().get(4); }
    @Bean com.communityos.api.billing.application.TargetSettlement targetSettlement(JdbcDueRepository dues, JdbcPaymentRepository payments, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        return new com.communityos.api.billing.application.TargetSettlement(dues, payments, events, audit, tx, clock);
    }
    @Bean com.communityos.api.billing.application.BillingDesk billingDesk(JdbcPaymentRepository payments, com.communityos.api.billing.application.TargetSettlement counter,
                                                                          NamedParameterJdbcTemplate jdbc, DomainEvents events, Clock clock) {
        return new com.communityos.api.billing.application.BillingDesk(payments, counter, new JdbcJournalWriter(jdbc), events, clock);
    }

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
    @Bean PaymentService paymentService(JdbcDueRepository dues, JdbcPaymentRepository payments, JdbcPaymentOrderRepository orders, GatewayRegistry gateways, GatewaySettlement settlement,
                                        JdbcPlatformPayments platform, DomainEvents events, Tx tx, Clock clock, CosProperties p) {
        return new PaymentService(dues, payments, orders, gateways, settlement, platform, platform, events, tx, clock, p.payments().orderTtl(), p.payments().currency());
    }
}
