package com.communityos.api.it;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.billing.adapter.JdbcBillingLookups;
import com.communityos.api.billing.adapter.JdbcDueRepository;
import com.communityos.api.billing.adapter.JdbcJournalWriter;
import com.communityos.api.billing.adapter.JdbcPaymentOrderRepository;
import com.communityos.api.billing.adapter.JdbcPaymentRepository;
import com.communityos.api.billing.adapter.JdbcPlatformPayments;
import com.communityos.api.billing.adapter.gateway.SimulatedGateway;
import com.communityos.api.billing.application.CounterSettlement;
import com.communityos.api.billing.application.DueService;
import com.communityos.api.billing.application.GatewaySettlement;
import com.communityos.api.billing.application.LedgerPoster;
import com.communityos.api.billing.application.PaymentService;
import com.communityos.api.billing.application.gateway.GatewayRegistry;
import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.billing.domain.DueStatus;
import com.communityos.api.identity.adapter.JdbcCallerLoader;
import com.communityos.api.identity.adapter.JdbcMemberRepository;
import com.communityos.api.identity.adapter.JdbcOtpStore;
import com.communityos.api.identity.adapter.JdbcPersonDirectory;
import com.communityos.api.identity.adapter.JdbcRateLimiter;
import com.communityos.api.identity.adapter.JdbcRefreshTokenStore;
import com.communityos.api.identity.adapter.JdbcRoleCatalog;
import com.communityos.api.identity.adapter.JwtTokenIssuer;
import com.communityos.api.identity.application.AuthService;
import com.communityos.api.identity.application.CodeHasher;
import com.communityos.api.identity.application.MemberService;
import com.communityos.api.identity.application.port.MemberRepository;
import com.communityos.api.property.adapter.JdbcUnitRepository;
import com.communityos.api.property.application.UnitService;
import com.communityos.api.property.application.port.UnitRepository;
import com.communityos.api.property.domain.Unit;
import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.custom.CustomFields;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.events.OutboxRelay;
import com.communityos.api.shared.integration.WebhookFanout;
import com.communityos.api.shared.jdbc.JdbcAuditWriter;
import com.communityos.api.shared.jdbc.JdbcFieldDefinitions;
import com.communityos.api.shared.jdbc.JdbcIdempotencyStore;
import com.communityos.api.shared.jdbc.JdbcOutboxStore;
import com.communityos.api.shared.jdbc.JdbcOutboxWriter;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.JwtCodec;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.Idempotency;
import com.communityos.api.shared.web.Json;
import com.communityos.api.shared.web.PageQuery;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;

/**
 * End to end on a migrated PostgreSQL (cos_v2), through the REAL adapters, as the REAL roles (cos_app with row-level security, cos_platform):
 * sign in with a code -> caller loaded from the database -> treasurer raises bills -> the owner sees only theirs -> pays online (simulated
 * provider) -> webhook replay -> office receipt with overpayment -> ledger balances -> outbox relayed -> another community sees nothing.
 */
class PostgresFlowTest {
    static <T> T as(Caller c, Supplier<T> w) { return CallerHolder.runAs(c, w); }

    /** Needs psql and a migrated cos_v2 on localhost:$PGPORT, default 5433 (tools/migrate-local.sh); skipped otherwise, e.g. in a plain `mvn test`. */
    static boolean databaseAvailable() {
        try { return new ProcessBuilder("psql", "-h", "localhost", "-p", PsqlJdbc.PORT, "-U", "postgres", "-d", "cos_v2", "-Atc", "select 1").start().waitFor() == 0; }
        catch (Exception e) { return false; }
    }

    @Test void fullFlow() throws Exception {
        if (!databaseAvailable()) { System.out.println("PostgresFlowTest skipped: no cos_v2 database on localhost:" + PsqlJdbc.PORT); return; }
        try (PsqlJdbc owner = new PsqlJdbc("cos_v2", null, false); PsqlJdbc app = new PsqlJdbc("cos_v2", "cos_app", true); PsqlJdbc platform = new PsqlJdbc("cos_v2", "cos_platform", false)) {
            String tag = Long.toString(System.nanoTime() % 1_000_000_000L);
            String phone = "+9197" + String.format("%08d", Long.parseLong(tag) % 100_000_000L);
            // ---- fixtures, as the schema owner ----------------------------------------------------------------------------------------------
            UUID cid = UUID.fromString((String) owner.sql("INSERT INTO platform.community (slug, name) VALUES ('flow-" + tag + "', 'Flow " + tag + "') RETURNING id").get(0).get("id"));
            UUID other = UUID.fromString((String) owner.sql("INSERT INTO platform.community (slug, name) VALUES ('other-" + tag + "', 'Other " + tag + "') RETURNING id").get(0).get("id"));
            owner.sql("SELECT platform.provision_community('" + cid + "'), platform.provision_community('" + other + "')");
            owner.sql("SELECT set_config('app.community_id', '" + cid + "', false)");
            owner.sql("UPDATE billing.charge_category SET tax_rate = 18 WHERE community_id = '" + cid + "' AND code = 'Maintenance' RETURNING 1");   // GST on maintenance
            UUID b1 = id(owner, "INSERT INTO property.block (community_id, name) VALUES ('" + cid + "', 'Block 1') RETURNING id");
            UUID b2 = id(owner, "INSERT INTO property.block (community_id, name) VALUES ('" + cid + "', 'Block 2') RETURNING id");
            UUID unitA = id(owner, "INSERT INTO property.unit (community_id, unit_no, block_id, unit_type) VALUES ('" + cid + "', 'Villa 101', '" + b1 + "', 'Villa') RETURNING id");
            UUID unitB = id(owner, "INSERT INTO property.unit (community_id, unit_no, block_id, unit_type) VALUES ('" + cid + "', 'Villa 202', '" + b2 + "', 'Villa') RETURNING id");
            UUID[] members = new UUID[3]; UUID[] persons = new UUID[3];
            String[] roles = {"owner", "treasurer", "super_admin"};
            for (int i = 0; i < 3; i++) {
                persons[i] = id(owner, "INSERT INTO identity.person (phone_e164, full_name) VALUES ('" + phone.substring(0, phone.length() - 1) + i + "', 'Person " + i + "') RETURNING id");
                members[i] = id(owner, "INSERT INTO identity.membership (community_id, person_id, display_name) VALUES ('" + cid + "', '" + persons[i] + "', 'Member " + roles[i] + "') RETURNING id");
                owner.sql("INSERT INTO identity.membership_role (community_id, membership_id, role_id, is_primary) SELECT '" + cid + "', '" + members[i] + "', id, true FROM identity.role WHERE community_id = '" + cid + "' AND code = '" + roles[i] + "' RETURNING 1");
            }
            owner.sql("INSERT INTO property.occupant (community_id, unit_id, person_id, relation, full_name, is_primary) VALUES ('" + cid + "', '" + unitA + "', '" + persons[0] + "', 'Owner', 'Person 0', true) RETURNING 1");
            owner.sql("SELECT set_config('app.community_id', '" + other + "', false)");
            UUID otherUnit = id(owner, "INSERT INTO property.unit (community_id, unit_no, unit_type) VALUES ('" + other + "', 'Villa 101', 'Villa') RETURNING id");

            // ---- wiring: the real adapters and services --------------------------------------------------------------------------------------
            Clock clock = Clock.system(ZoneId.of("Asia/Kolkata"));
            ObjectMapper json = Json.mapper();
            json.registerModule(new SimpleModule().addSerializer(Instant.class, ToStringSerializer.instance).addSerializer(LocalDate.class, ToStringSerializer.instance)); // jsr310 is on the real classpath
            KeyPairGenerator g = KeyPairGenerator.getInstance("EC"); g.initialize(new ECGenParameterSpec("secp256r1")); KeyPair kp = g.generateKeyPair();
            JwtCodec codec = new JwtCodec(new JwtCodec.Keys("k1", kp.getPrivate(), Map.of("k1", kp.getPublic())), "it", "app", clock);
            List<String> codes = new ArrayList<>();
            JdbcRefreshTokenStore refreshStore = new JdbcRefreshTokenStore(platform);
            AuthService auth = new AuthService(new JdbcOtpStore(platform), refreshStore, new JdbcPersonDirectory(platform), (to, code) -> codes.add(code),
                new JdbcRateLimiter(platform), new JwtTokenIssuer(codec, Duration.ofMinutes(10), clock), new CodeHasher("integration-test-pepper-0123456789"), platform, clock,
                AuthService.Settings.defaults());
            JdbcCallerLoader callers = new JdbcCallerLoader(platform, Duration.ofSeconds(30), clock);
            var inbox = new com.communityos.api.comms.adapter.JdbcInbox(app);
            List<com.communityos.api.shared.events.DomainEventHandler<?>> handlers = new ArrayList<>(new LedgerPoster(new JdbcJournalWriter(app), ZoneId.of("Asia/Kolkata")).handlers());
            handlers.add(new com.communityos.api.comms.application.Notifier(inbox, inbox));   // every event below also lands in the inboxes
            DomainEvents events = new DomainEvents(handlers, new JdbcOutboxWriter(app, json));
            JdbcAuditWriter audit = new JdbcAuditWriter(app, json);
            JdbcDueRepository dues = new JdbcDueRepository(app); JdbcBillingLookups lookups = new JdbcBillingLookups(app);
            JdbcPaymentOrderRepository orders = new JdbcPaymentOrderRepository(app); JdbcPaymentRepository payments = new JdbcPaymentRepository(app);
            SimulatedGateway sim = new SimulatedGateway("sim-secret");
            GatewaySettlement gs = new GatewaySettlement(dues, payments, events, audit, app, orders, clock);
            CounterSettlement counter = new CounterSettlement(dues, payments, events, audit, app, lookups, clock);
            JdbcPlatformPayments pp = new JdbcPlatformPayments(platform);
            PaymentService pay = new PaymentService(dues, payments, orders, new GatewayRegistry(List.of(sim), "simulated"), gs, pp, pp, events, app, clock, Duration.ofMinutes(30), "INR");
            DueService dueService = new DueService(dues, lookups, lookups, events, audit, app, clock);
            UnitService units = new UnitService(new JdbcUnitRepository(app, json), new CustomFields(new JdbcFieldDefinitions(app)), audit, app);
            MemberService memberService = new MemberService(new JdbcMemberRepository(app, json), new JdbcRoleCatalog(app), new JdbcPersonDirectory(platform), refreshStore,
                callers, audit, app, clock, "+91");
            Idempotency idem = new Idempotency(new JdbcIdempotencyStore(app), json);

            // ---- 1. sign in ---------------------------------------------------------------------------------------------------------------------
            String ownerPhone = phone.substring(0, phone.length() - 1) + "0";
            AuthService.CodeRequested req = auth.requestCode(ownerPhone, new AuthService.Client("it", "10.1.2.3"));
            assertThrows(com.communityos.api.shared.security.Unauthenticated.class, () -> auth.verify(req.challengeId(), codes.get(0).equals("000000") ? "999999" : "000000", null, new AuthService.Client("it", "10.1.2.3")));
            assertEquals("1", platform.sql("SELECT attempts::text AS a FROM identity.otp_challenge WHERE id = '" + req.challengeId() + "'").get(0).get("a"), "the wrong guess was committed");
            AuthService.SignedIn in = (AuthService.SignedIn) auth.verify(req.challengeId(), codes.get(0), null, new AuthService.Client("it", "10.1.2.3"));
            Map<String, Object> claims = codec.verify(in.tokens().accessToken());
            Caller ownerC = callers.load(new PersonId(UUID.fromString((String) claims.get("sub"))), new CommunityId(UUID.fromString((String) claims.get("cid"))),
                new MembershipId(UUID.fromString((String) claims.get("mid")))).orElseThrow();
            assertEquals(Caller.Category.Resident, ownerC.category()); assertEquals(java.util.Set.of(new UnitId(unitA)), ownerC.units());
            AuthService.Tokens rotated = auth.refresh(in.tokens().refreshToken(), new AuthService.Client("it", "10.1.2.3"));
            assertThrows(com.communityos.api.shared.security.Unauthenticated.class, () -> auth.refresh(in.tokens().refreshToken(), new AuthService.Client("it", "10.1.2.3")));
            assertThrows(com.communityos.api.shared.security.Unauthenticated.class, () -> auth.refresh(rotated.refreshToken(), new AuthService.Client("it", "10.1.2.3")), "reuse revoked the family");
            Caller treasurer = callers.load(new PersonId(persons[1]), new CommunityId(cid), new MembershipId(members[1])).orElseThrow();
            Caller admin = callers.load(new PersonId(persons[2]), new CommunityId(cid), new MembershipId(members[2])).orElseThrow();
            assertTrue(treasurer.has(com.communityos.api.shared.security.Permission.MANAGE_DUES)); assertTrue(admin.isSuperAdmin());
            assertTrue(callers.load(new PersonId(persons[1]), new CommunityId(other), new MembershipId(members[1])).isEmpty(), "membership is per community");

            // ---- 2. bills ---------------------------------------------------------------------------------------------------------------------------
            LocalDate today = LocalDate.now(clock);
            Due a1 = as(treasurer, () -> dueService.raise(treasurer, new DueService.RaiseDue(new UnitId(unitA), "Maintenance", today.withDayOfMonth(1).minusMonths(1), "Sep", Money.of("3000"), today.minusDays(20))));
            Due a2 = as(treasurer, () -> dueService.raise(treasurer, new DueService.RaiseDue(new UnitId(unitA), "Water", today.withDayOfMonth(1), "Oct", Money.of("420"), today.plusDays(5))));
            Due b1d = as(treasurer, () -> dueService.raise(treasurer, new DueService.RaiseDue(new UnitId(unitB), "Maintenance", today.withDayOfMonth(1), "Oct", Money.of("3000"), today.plusDays(5))));
            assertEquals(Money.of("540"), a1.tax()); assertTrue(a1.shortId().startsWith("DUE-"));
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> dueService.raise(ownerC, new DueService.RaiseDue(new UnitId(unitA), "Maintenance", null, null, Money.of("1"), today))));
            var mine = as(ownerC, () -> dueService.list(ownerC, new DueRepository.Filter(null, null, null, null, null, false), PageQuery.of(50, 0)));
            assertEquals(2, mine.total(), "the owner sees only their unit's bills");
            assertThrows(AccessDenied.NotVisible.class, () -> as(ownerC, () -> dueService.get(ownerC, b1d.id())));
            assertEquals(3, as(treasurer, () -> dueService.list(treasurer, new DueRepository.Filter(null, null, null, null, null, true), PageQuery.of(50, 0))).total());

            // ---- 3. pay online -------------------------------------------------------------------------------------------------------------------
            PaymentService.OrderView order = as(ownerC, () -> pay.createOrder(ownerC, new PaymentService.CreateOrder(List.of(a1.id(), a2.id())), "it-order-" + tag));
            assertEquals(Money.of("3960"), order.order().amount(), "3540 + 420, priced by the server");
            assertEquals(order.order().id(), as(ownerC, () -> pay.createOrder(ownerC, new PaymentService.CreateOrder(List.of(a1.id(), a2.id())), "it-order-" + tag)).order().id());
            Map<String, String> paid = sim.simulatePay(order.order().providerOrderRef(), true);
            PaymentRepository.Receipt r = as(ownerC, () -> pay.confirm(ownerC, order.order().id(), paid.get("providerPaymentRef"), paid.get("signature")));
            assertTrue(r.receiptNo().startsWith("RCP-")); assertEquals(2, r.allocations().size());
            assertEquals(DueStatus.PAID, as(ownerC, () -> dueService.get(ownerC, a1.id())).status());
            byte[] hook = ("evt-" + tag + ",payment.captured," + order.order().providerOrderRef() + "," + paid.get("providerPaymentRef")).getBytes();
            Map<String, String> h = Map.of("x-simulated-signature", Crypto.hmacHex("sim-secret", hook));
            pay.webhook("simulated", h, hook); pay.webhook("simulated", h, hook);
            assertEquals("1", owner.sql("SELECT count(*)::text AS n FROM billing.payment WHERE provider_payment_ref = '" + paid.get("providerPaymentRef") + "'").get(0).get("n"), "recorded once");
            assertEquals("Paid", owner.sql("SELECT status FROM billing.payment_order WHERE id = '" + order.order().id() + "'").get(0).get("status"));

            // ---- 4. office receipt, overpaid ---------------------------------------------------------------------------------------------------------
            Idempotency.Reply<PaymentRepository.Receipt> cr = as(treasurer, () -> idem.run(treasurer, "it-receipt-" + tag, "POST /api/v1/payments", Map.of("unit", unitB.toString()),
                PaymentRepository.Receipt.class, 201, () -> counter.settle(treasurer, new CounterSettlement.Request(new UnitId(unitB), Money.of("4000"), "Cheque", today, null, "CHQ 1"))));
            assertEquals(Money.of("460"), cr.body().toCredit());
            assertEquals("460.00", owner.sql("SELECT sum(amount)::text AS s FROM billing.unit_credit WHERE community_id = '" + cid + "'").get(0).get("s"));

            // ---- 5. the books balance; receivables are settled -----------------------------------------------------------------------------------
            Map<String, Object> bal = owner.sql("SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM finance.account_balance WHERE community_id = '" + cid + "'").get(0);
            assertEquals(bal.get("d"), bal.get("c"), "double entry balances");
            assertEquals("0.00", owner.sql("SELECT balance::text AS b FROM finance.account_balance ab JOIN finance.account a ON a.id = ab.account_id WHERE ab.community_id = '" + cid + "' AND a.code = '1100'").get(0).get("b"));
            assertEquals("5", owner.sql("SELECT count(*)::text AS n FROM finance.journal_entry WHERE community_id = '" + cid + "' AND status = 'Posted'").get(0).get("n"), "3 bills + 2 payments");

            // ---- 6. units, members -----------------------------------------------------------------------------------------------------------------
            Unit u = as(admin, () -> units.get(admin, new UnitId(unitA)));
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> units.change(ownerC, new UnitId(unitA), u.version(), new Unit.Changes(null, "Vacant", null, null, null), null)));
            Unit changed = as(admin, () -> units.change(admin, new UnitId(unitA), u.version(), new Unit.Changes(null, "Tenant occupied", null, "Quarterly", null), null));
            assertEquals("Tenant occupied", changed.occupancy()); assertEquals(u.version() + 1, changed.version(), "version stamped by the database");
            assertThrows(DomainException.Conflict.class, () -> as(admin, () -> units.change(admin, new UnitId(unitA), u.version(), new Unit.Changes(null, "Vacant", null, null, null), null)), "stale version");
            assertEquals(1, as(ownerC, () -> units.list(ownerC, new UnitRepository.Filter(null, null, null, false), PageQuery.of(50, 0))).total());
            var added = as(admin, () -> memberService.add(admin, new MemberService.AddMember("+9196" + String.format("%08d", Long.parseLong(tag) % 100_000_000L), "New Tenant", null, "resident", new UnitId(unitB), "Tenant")));
            assertEquals("resident", added.roles().get(0).code());
            assertEquals(1, as(ownerC, () -> memberService.list(ownerC, new MemberRepository.Filter(null, null, null), PageQuery.of(50, 0))).total(), "a resident sees only themselves");
            assertThrows(AccessDenied.class, () -> as(treasurer, () -> memberService.changeRoles(treasurer, new MembershipId(members[0]), new MemberService.ChangeRoles(List.of("super_admin"), null), 1)));

            assertTrue(as(ownerC, () -> new JdbcRoleCatalog(app).all()).stream().anyMatch((x) -> x.code().equals("treasurer") && x.permissions().contains(com.communityos.api.shared.security.Permission.MANAGE_DUES)));
            assertEquals(cid, new com.communityos.api.identity.adapter.JdbcCommunityDirectory(platform).bySlug("flow-" + tag).orElseThrow().id());
            assertTrue(new com.communityos.api.identity.adapter.JdbcCommunityDirectory(platform).bySlug("x'; drop table --").isEmpty());

            // ---- 6b. maintenance: raise, auto-assign, discussion, work, close -------------------------------------------------------------------
            UUID plumberPerson = id(owner, "INSERT INTO identity.person (phone_e164, full_name) VALUES ('+9195" + String.format("%08d", Long.parseLong(tag) % 100_000_000L) + "', 'Ravi Plumber') RETURNING id");
            owner.sql("SELECT set_config('app.community_id', '" + cid + "', false)");
            UUID plumberMember = id(owner, "INSERT INTO identity.membership (community_id, person_id, display_name) VALUES ('" + cid + "', '" + plumberPerson + "', 'Ravi Plumber') RETURNING id");
            owner.sql("INSERT INTO identity.membership_role (community_id, membership_id, role_id, is_primary) SELECT '" + cid + "', '" + plumberMember + "', id, true FROM identity.role WHERE community_id = '" + cid + "' AND code = 'handyman_plumbing' RETURNING 1");
            com.communityos.api.maintenance.adapter.JdbcMaintenanceDirectory mdir = new com.communityos.api.maintenance.adapter.JdbcMaintenanceDirectory(app);
            com.communityos.api.maintenance.application.FieldStaffService staffSvc = new com.communityos.api.maintenance.application.FieldStaffService(mdir, mdir, audit, app);
            var fs = as(admin, () -> staffSvc.add(admin, new MembershipId(plumberMember), "Plumbing", "Morning", null));
            Caller plumberC = callers.load(new PersonId(plumberPerson), new CommunityId(cid), new MembershipId(plumberMember)).orElseThrow();
            assertEquals("Plumbing", plumberC.trade());
            as(plumberC, () -> staffSvc.clock(plumberC, fs.id(), true, fs.version()));
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> staffSvc.clock(ownerC, fs.id(), false, fs.version() + 1)));
            var planCodec = new com.communityos.api.approval.application.PlanCodec(json);
            var qrepo = new com.communityos.api.maintenance.adapter.JdbcQuotationRepository(app, planCodec);
            var trepo = new com.communityos.api.maintenance.adapter.JdbcTicketRepository(app, json);
            com.communityos.api.maintenance.application.TicketService ticketSvc = new com.communityos.api.maintenance.application.TicketService(trepo, mdir, mdir, qrepo, events, audit, app, clock);
            var leak = as(ownerC, () -> ticketSvc.raise(ownerC, new com.communityos.api.maintenance.application.TicketService.RaiseTicket(null, "Leak in kitchen", "Under the sink", null, "Unit", null, "Plumbing", null, "High", null, null)));
            assertEquals("TKT-1051", leak.shortId()); assertEquals("Assigned", leak.status().label(), "the one clocked-in plumber got it");
            assertEquals(new MembershipId(plumberMember), leak.assignee());
            var street = as(admin, () -> ticketSvc.raise(admin, new com.communityos.api.maintenance.application.TicketService.RaiseTicket(null, "Street light out", null, null, "Community", "Gate 2", "Electrical", null, null, null, null)));
            as(plumberC, () -> ticketSvc.comment(plumberC, leak.id(), "Washer needed, coming at 4", "Public"));
            as(plumberC, () -> ticketSvc.comment(plumberC, leak.id(), "Charge the washer to stock", "Internal"));
            assertEquals(1, as(ownerC, () -> ticketSvc.comments(ownerC, leak.id())).size(), "no internal notes for the resident");
            assertEquals(2, as(admin, () -> ticketSvc.comments(admin, leak.id())).size());
            assertEquals(1, as(ownerC, () -> ticketSvc.recentComments(ownerC, 100)).size());
            var working = as(plumberC, () -> ticketSvc.changeStatus(plumberC, leak.id(), leak.version(), com.communityos.api.maintenance.domain.TicketStatus.IN_PROGRESS, null));
            var done = as(plumberC, () -> ticketSvc.changeStatus(plumberC, leak.id(), working.version(), com.communityos.api.maintenance.domain.TicketStatus.COMPLETED, null));
            assertThrows(AccessDenied.class, () -> as(plumberC, () -> ticketSvc.changeStatus(plumberC, leak.id(), done.version(), com.communityos.api.maintenance.domain.TicketStatus.CLOSED, null)));
            var closed = as(ownerC, () -> ticketSvc.changeStatus(ownerC, leak.id(), done.version(), com.communityos.api.maintenance.domain.TicketStatus.CLOSED, null));
            assertEquals(4, as(ownerC, () -> ticketSvc.rate(ownerC, leak.id(), 4)).state().residentRating.intValue());
            assertNotNull(closed.state().closedAt);
            assertEquals(2, as(ownerC, () -> ticketSvc.list(ownerC, new com.communityos.api.maintenance.application.port.TicketRepository.Filter(null, false, null, null, null, null, null), PageQuery.of(50, 0))).total(),
                "own ticket + the community request");
            assertEquals(1, as(ownerC, () -> ticketSvc.meToo(ownerC, street.id(), null, true)).state().affectedUnits.size());
            assertEquals("Closed", owner.sql("SELECT status FROM maintenance.ticket WHERE id = '" + leak.id() + "'").get(0).get("status"));
            assertEquals(1, as(plumberC, () -> ticketSvc.list(plumberC, new com.communityos.api.maintenance.application.port.TicketRepository.Filter(null, false, null, null, null, new MembershipId(plumberMember), null), PageQuery.of(50, 0))).total());

            // ---- 6c. money on a task: quotation -> EC + final approval -> invoice over budget -> release blocks closing ----------------------------
            var docsSvc = new com.communityos.api.maintenance.application.QuotationService(trepo, qrepo, qrepo, new com.communityos.api.approval.adapter.JdbcApprovalSettings(app, json),
                events, audit, app, clock);
            UUID purchase = id(owner, "SELECT id FROM maintenance.task_type WHERE community_id = '" + cid + "' AND name = 'Purchase'");
            var pump = as(admin, () -> ticketSvc.raise(admin, new com.communityos.api.maintenance.application.TicketService.RaiseTicket(purchase, "Replace borewell pump", null, null, "Community", "Pump room", "MEP", null, "High", null, null)));
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> docsSvc.add(admin, pump.id(), new com.communityos.api.maintenance.application.QuotationService.AddDocument("Quotation", "Aqua Pumps", new java.math.BigDecimal("10000"), "Extra", new java.math.BigDecimal("18"), today, null))),
                "not marked as involving money yet");
            var pumpFin = as(admin, () -> ticketSvc.edit(admin, pump.id(), pump.version(), new com.communityos.api.maintenance.domain.Ticket.Changes(null, null, null, null, null, null, null, null, null, null, true, null)));
            assertTrue(pumpFin.financial());
            var quote = as(admin, () -> docsSvc.add(admin, pump.id(), new com.communityos.api.maintenance.application.QuotationService.AddDocument("Quotation", "Aqua Pumps", new java.math.BigDecimal("10000"), "Extra", new java.math.BigDecimal("18"), today, "2 HP")));
            assertEquals(0, Money.of("11800").compareTo(quote.amount())); assertEquals("QUO", quote.shortId().substring(0, 3));
            assertThrows(DomainException.RuleViolated.class, () -> as(treasurer, () -> docsSvc.decide(treasurer, quote.id(), quote.version(), "Approved", null, false)), "select it first");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> docsSvc.ofTicket(ownerC, pump.id())), "residents do not see the money side");
            var sel = as(admin, () -> docsSvc.select(admin, quote.id(), quote.version()));
            assertTrue(sel.selected());
            var ec = as(treasurer, () -> docsSvc.decide(treasurer, quote.id(), sel.version(), "Approved", "OK", false));
            assertEquals("Approved", ec.state().ecApproval); assertTrue(ec.state().finalRequired); assertEquals("pending-final", ec.approvalKey());
            owner.sql("UPDATE finance.finance_setting SET approval_separate = true WHERE community_id = '" + cid + "' RETURNING 1");
            var sep = assertThrows(AccessDenied.class, () -> as(treasurer, () -> docsSvc.decide(treasurer, quote.id(), ec.version(), "Approved", null, false)), "separate approvers: one step each");
            assertTrue(sep.getMessage().contains("another step"), sep.getMessage());
            owner.sql("UPDATE finance.finance_setting SET approval_separate = false WHERE community_id = '" + cid + "' RETURNING 1");
            var fin = as(admin, () -> docsSvc.decide(admin, quote.id(), ec.version(), "Approved", null, false));
            assertTrue(fin.approved());
            var pumpNow = as(admin, () -> ticketSvc.get(admin, pump.id()));
            assertEquals("Approved", pumpNow.approval().quotationStatus()); assertEquals(0, Money.of("11800").compareTo(pumpNow.approval().approvedAmount()));
            var inv = as(admin, () -> docsSvc.add(admin, pump.id(), new com.communityos.api.maintenance.application.QuotationService.AddDocument("Invoice", "Aqua Pumps", new java.math.BigDecimal("11000"), "Extra", new java.math.BigDecimal("18"), today, null)));
            assertTrue(inv.state().overBudget, "12980 is above 11800 + 5%"); assertEquals("pending-ec", inv.approvalKey());
            var inv1 = as(treasurer, () -> docsSvc.decide(treasurer, inv.id(), inv.version(), "Approved", null, false));
            var inv2 = as(admin, () -> docsSvc.decide(admin, inv.id(), inv1.version(), "Approved", null, false));
            assertTrue(inv2.approved());
            var pos = as(treasurer, () -> docsSvc.position(treasurer, pump.id()));
            assertEquals("Invoice", pos.basis()); assertEquals(0, Money.of("12980").compareTo(pos.cap())); assertEquals(0, Money.ZERO.compareTo(pos.committed()));
            owner.sql("SELECT set_config('app.community_id', '" + cid + "', false)");
            owner.sql("INSERT INTO finance.release (community_id, ticket_id, kind, amount, status) VALUES ('" + cid + "', '" + pump.id() + "', 'Against invoice', 5000, 'Waiting approval') RETURNING 1");
            assertEquals(1, as(treasurer, () -> docsSvc.position(treasurer, pump.id())).openReleases());
            var pumpV = as(admin, () -> ticketSvc.get(admin, pump.id()));
            var e1 = assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> ticketSvc.changeStatus(admin, pump.id(), pumpV.version(), com.communityos.api.maintenance.domain.TicketStatus.CANCELLED, "no longer needed")));
            assertTrue(e1.getMessage().contains("5000"), e1.getMessage());
            var e2 = assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> docsSvc.decide(admin, quote.id(), fin.version(), "Pending", null, false)));
            assertTrue(e2.getMessage().contains("released or paid"), e2.getMessage());
            assertEquals(2, as(admin, () -> docsSvc.all(admin)).size());
            assertEquals("Nothing is waiting for a decision", docsSvc.whyNot(treasurer, inv2));

            // ---- 6d. registers through the resource kit: task types as a resident sees them, a wish with votes -----------------------------------
            var kit = new com.communityos.api.shared.resource.ResourceService(events, audit, app, clock);
            var ttRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.maintenance.MaintenanceResources.TASK_TYPES.table(), app, json);
            var residentTypes = as(ownerC, () -> kit.list(ownerC, com.communityos.api.maintenance.MaintenanceResources.TASK_TYPES, ttRepo));
            assertEquals(2, residentTypes.size(), "Resident Maintenance + Pest Control: " + residentTypes);
            assertEquals(6, as(admin, () -> kit.list(admin, com.communityos.api.maintenance.MaintenanceResources.TASK_TYPES, ttRepo)).size());
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> kit.create(ownerC, com.communityos.api.maintenance.MaintenanceResources.TASK_TYPES, ttRepo,
                new com.communityos.api.maintenance.MaintenanceResources.TaskTypeFields("Painting", null, "Anyone", "Direct assign", null, null, null, null, null, true, false, true))));
            var paint = as(admin, () -> kit.create(admin, com.communityos.api.maintenance.MaintenanceResources.TASK_TYPES, ttRepo,
                new com.communityos.api.maintenance.MaintenanceResources.TaskTypeFields("Painting", "🎨", "Anyone", "Direct assign", "No", null, null, null, null, true, false, true)));
            assertEquals("Painting", paint.data().name());
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> { kit.delete(admin, com.communityos.api.maintenance.MaintenanceResources.TASK_TYPES, ttRepo, paint.id(), paint.version()); return null; }));
            var wishRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.maintenance.MaintenanceResources.WISHES.table(), app, json);
            var wish = as(ownerC, () -> kit.create(ownerC, com.communityos.api.maintenance.MaintenanceResources.WISHES, wishRepo,
                new com.communityos.api.maintenance.MaintenanceResources.WishFields("Shade over the kids' park", "Afternoons are too hot", "Amenities", "Park", null, "Planned", java.math.BigDecimal.TEN, "x")));
            assertEquals("Submitted", wish.data().status(), "the server sets the status of a new wish"); assertNull(wish.data().estimate());
            assertEquals(unitA, wish.data().unitId()); assertEquals("Villa 101", wish.server("unit")); assertEquals(members[0].toString(), String.valueOf(wish.server("raisedById")));
            var registry = new com.communityos.api.shared.resource.ResourceRegistry(app, json).add(com.communityos.api.maintenance.MaintenanceResources.WISHES);
            var votes = new com.communityos.api.maintenance.application.WishVotes(app, kit, registry, json);
            as(treasurer, () -> votes.vote(treasurer, wish.id(), true));
            var voted = as(admin, () -> votes.vote(admin, wish.id(), true));
            assertEquals(2, voted.path("votes").size());
            var reviewed = as(admin, () -> kit.replace(admin, com.communityos.api.maintenance.MaintenanceResources.WISHES, wishRepo, wish.id(), voted.path("version").asLong(),
                new com.communityos.api.maintenance.MaintenanceResources.WishFields("Shade over the kids' park", "Afternoons are too hot", "Amenities", "Park", null, "Planned", new java.math.BigDecimal("85000"), "In the next budget")));
            assertEquals("Planned", reviewed.data().status()); assertEquals(unitA, reviewed.data().unitId(), "the unit does not move");
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> kit.replace(ownerC, com.communityos.api.maintenance.MaintenanceResources.WISHES, wishRepo, wish.id(), reviewed.version(),
                new com.communityos.api.maintenance.MaintenanceResources.WishFields("Shade", null, null, null, null, "Planned", null, null))), "being reviewed now");
            assertThrows(AccessDenied.class, () -> as(plumberC, () -> kit.replace(plumberC, com.communityos.api.maintenance.MaintenanceResources.WISHES, wishRepo, wish.id(), reviewed.version(),
                new com.communityos.api.maintenance.MaintenanceResources.WishFields("Shade", null, null, null, null, "Withdrawn", null, null))), "not theirs");

            // ---- 6e. amenities: an amenity through the kit, a prepaid booking, a cash booking, cancel with refund, deposit, the books balance ---------
            var amTypes = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.amenity.AmenityResources.TYPES.table(), app, json);
            var hallItem = as(admin, () -> kit.create(admin, com.communityos.api.amenity.AmenityResources.TYPES, amTypes, new com.communityos.api.amenity.AmenityResources.TypeFields(
                "Party Hall", "🎉", null, true, null, new java.math.BigDecimal("5000"), "Per day / event", null, true, new java.math.BigDecimal("18"), "Exclusive", new java.math.BigDecimal("2000"),
                List.of(new com.communityos.api.amenity.domain.AmenityType.Tier(new java.math.BigDecimal("48"), new java.math.BigDecimal("100")), new com.communityos.api.amenity.domain.AmenityType.Tier(java.math.BigDecimal.ZERO, new java.math.BigDecimal("25"))),
                0, 120, 1, "09:00–23:00", "Full day", "No loud music after 22:00", "Reservation required", List.of(), null, null, null, List.of(), List.of(), List.of())));
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> kit.create(ownerC, com.communityos.api.amenity.AmenityResources.TYPES, amTypes, hallItem.data())));
            var bookingSvc = new com.communityos.api.amenity.application.BookingService(new com.communityos.api.amenity.adapter.JdbcBookingRepository(app, json),
                new com.communityos.api.amenity.adapter.JdbcAmenityCatalog(app, json), new com.communityos.api.billing.application.BillingDesk(payments,
                    new com.communityos.api.billing.application.TargetSettlement(dues, payments, events, audit, app, clock), new JdbcJournalWriter(app), events, clock),
                new com.communityos.api.amenity.application.AmenityLedger(new com.communityos.api.billing.application.BillingDesk(payments,
                    new com.communityos.api.billing.application.TargetSettlement(dues, payments, events, audit, app, clock), new JdbcJournalWriter(app), events, clock), ZoneId.of("Asia/Kolkata")),
                events, audit, app, clock, ZoneId.of("Asia/Kolkata"));
            LocalDate party = today.plusDays(10);
            // the resident pays online first (a prepayment), then books with it
            PaymentService.OrderView pre = as(ownerC, () -> pay.createOrder(ownerC, new PaymentService.CreateOrder(List.of(), "booking", new UnitId(unitA), Money.of("7900")), "it-book-" + tag));
            assertEquals("booking", pre.order().purpose());
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> pay.createOrder(ownerC, new PaymentService.CreateOrder(List.of(), "booking", new UnitId(unitB), Money.of("10")), "it-book-x-" + tag)), "another unit");
            Map<String, String> prePaid = sim.simulatePay(pre.order().providerOrderRef(), true);
            PaymentRepository.Receipt preR = as(ownerC, () -> pay.confirm(ownerC, pre.order().id(), prePaid.get("providerPaymentRef"), prePaid.get("signature")));
            assertEquals(Money.of("7900"), preR.toCredit(), "a prepayment waits as the unit's credit");
            assertEquals(preR.id().value(), as(ownerC, () -> pay.getOrder(ownerC, pre.order().id())).paymentId());
            var booked = as(ownerC, () -> bookingSvc.book(ownerC, new com.communityos.api.amenity.application.BookingService.Book(hallItem.id(), new UnitId(unitA), party, null, "UPI",
                preR.id().value(), false, "Unit", null, false, null, Map.of())));
            assertEquals("Confirmed", booked.status()); assertEquals("BKG", booked.shortId().substring(0, 3)); assertEquals("7900.00", booked.total().toPlainString());
            assertEquals("Held", booked.state().depositStatus); assertEquals(2, booked.state().policy.size(), "the tiers it was booked under");
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> bookingSvc.book(admin, new com.communityos.api.amenity.application.BookingService.Book(hallItem.id(), new UnitId(unitB),
                party, null, "Cash", null, false, "Unit", null, false, null, Map.of()))), "one hall, one booking a day");
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> bookingSvc.book(ownerC, new com.communityos.api.amenity.application.BookingService.Book(hallItem.id(), new UnitId(unitA),
                party.plusDays(1), null, "UPI", preR.id().value(), false, "Unit", null, false, null, Map.of()))), "the prepayment is used");
            assertEquals(1, as(ownerC, () -> bookingSvc.availability(ownerC, hallItem.id(), today, today.plusDays(30))).size());
            // a second booking paid at the office by the team, then cancelled late: a quarter back, the deposit in full, to the unit's credit
            var later = as(admin, () -> bookingSvc.book(admin, new com.communityos.api.amenity.application.BookingService.Book(hallItem.id(), new UnitId(unitB), today.plusDays(1), null, "Cash", null,
                false, "Unit", null, false, null, Map.of())));
            assertEquals("Confirmed", later.status()); assertNotNull(later.state().paymentId);
            var cancelled = as(admin, () -> bookingSvc.cancel(admin, later.id(), later.version(), new com.communityos.api.amenity.application.BookingService.Cancel("Hall closed for repairs", true, false, null)));
            assertEquals("Credited to unit account", cancelled.state().refundStatus); assertEquals("25", cancelled.state().refundPct.stripTrailingZeros().toPlainString());
            assertEquals("3475.00", cancelled.state().refundAmount.toPlainString(), "25% of 5900 + 2000");
            // the deposit of the first booking: 500 kept, the rest to credit
            var settled = as(admin, () -> bookingSvc.settleDeposit(admin, booked.id(), booked.version(), new java.math.BigDecimal("500"), "Broken chair", "Unit credit"));
            assertEquals("Partly forfeited", settled.state().depositStatus); assertEquals("Credited to unit account", settled.state().depositRefundStatus);
            assertEquals(1, as(ownerC, () -> bookingSvc.list(ownerC, new com.communityos.api.amenity.application.port.BookingRepository.Filter(null, null, null, null, null, false))).size(), "own bookings only");
            Map<String, Object> bal2 = owner.sql("SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM finance.account_balance WHERE community_id = '" + cid + "'").get(0);
            assertEquals(bal2.get("d"), bal2.get("c"), "double entry still balances");
            java.util.function.Function<String, String> acct = (code) -> (String) owner.sql("SELECT coalesce(balance, 0)::text AS b FROM finance.account a LEFT JOIN finance.account_balance ab ON ab.account_id = a.id AND ab.community_id = a.community_id WHERE a.community_id = '" + cid + "' AND a.code = '" + code + "'").get(0).get("b");
            assertEquals("0.00", acct.apply("2200"), "no deposit is still held");
            assertEquals("0.00", acct.apply("1100"), "nothing is owed");
            assertEquals("1500.00", owner.sql("SELECT sum(amount)::text AS s FROM billing.unit_credit WHERE community_id = '" + cid + "' AND unit_id = '" + unitA + "'").get(0).get("s"), "the deposit back as credit");

            // ---- 6f. the gate: a pass, an approval with "always allow", deliveries by the unit's rule, household staff, goods, patrols, the sweep ---------
            var gateSvc = new com.communityos.api.gate.application.GateService(new com.communityos.api.gate.adapter.JdbcGateStore(app), new com.communityos.api.gate.adapter.JdbcGateDirectory(app, json),
                events, audit, app, clock, ZoneId.of("Asia/Kolkata"));
            var pass = as(ownerC, () -> gateSvc.createPass(ownerC, new com.communityos.api.gate.application.GateService.NewPass("Meera", null, null, "One-time", null, null, null, null, List.of(), null,
                null, null, null, null, false, null, null)));
            assertTrue(pass.code.matches("\\d{6}")); assertEquals(new UnitId(unitA), pass.unit);
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> gateSvc.createPass(ownerC, new com.communityos.api.gate.application.GateService.NewPass("X", null, new UnitId(unitB), null, null, null,
                null, null, List.of(), null, null, null, null, null, false, null, null))), "another unit's pass");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> gateSvc.findPasses(ownerC, pass.code)), "the desk is the guards'");
            var found = as(admin, () -> gateSvc.findPasses(admin, "GGP|" + pass.code));
            assertEquals(1, found.size()); assertEquals("", found.get(0).problem());
            var in1 = as(admin, () -> gateSvc.admitPass(admin, pass.id, "Main gate", null, null));
            assertTrue(in1.ok()); assertEquals("Inside", in1.visit().state.label); assertNotNull(in1.visit().expectedUntil);
            assertEquals("This one-time pass has already been used", as(admin, () -> gateSvc.admitPass(admin, pass.id, "Main gate", null, null)).reason());
            // the guard asks; the resident approves and always allows; the guard opens by hand (a flag)
            var asked = as(admin, () -> gateSvc.ask(admin, new com.communityos.api.gate.application.GateService.Ask("Guest", "Ravi Uncle", null, null, "KA01AB1234", "Visit", new UnitId(unitA), "Main gate", null, null, null, null, null)));
            assertEquals("Awaiting approval", asked.visit().state.label); assertEquals("Pending", asked.approval().status);
            assertThrows(AccessDenied.class, () -> as(treasurer, () -> gateSvc.answer(treasurer, asked.approval().id, "Approved", false)), "not the treasurer's unit");
            var ans = as(ownerC, () -> gateSvc.answer(ownerC, asked.approval().id, "Approved", true));
            assertEquals("Approved", ans.status); assertTrue(ans.alwaysAllow);
            assertEquals("Approved", as(ownerC, () -> gateSvc.answer(ownerC, asked.approval().id, "Denied", false)).status, "the first answer wins");
            assertEquals(1, as(ownerC, () -> gateSvc.passes(ownerC, "Active")).stream().filter((x) -> "Ravi Uncle".equals(x.visitorName) && "Recurring".equals(x.type)).count(), "a standing pass");
            var vAsked = as(admin, () -> gateSvc.visits(admin, new com.communityos.api.gate.application.port.GateStore.VisitFilter("Approved", null, null, null, false))).get(0);
            var opened = as(admin, () -> gateSvc.admitApproved(admin, vAsked.id, vAsked.version, "Kiosk offline"));
            assertEquals("Manual open", opened.method);
            var left = as(admin, () -> gateSvc.exit(admin, opened.id, opened.version, null));
            assertEquals("Exited", left.state.label); assertNotNull(left.outAt);
            // deliveries: an approved company walks in; once the unit is away, it is left at the gate
            var amazon = as(admin, () -> gateSvc.delivery(admin, "Rider", null, null, "Amazon", new UnitId(unitA), "Main gate", null));
            assertEquals("admitted", amazon.outcome());
            var unknown = as(admin, () -> gateSvc.delivery(admin, "Rider 2", null, null, "LocalShop", new UnitId(unitA), "Main gate", null));
            assertEquals("ask", unknown.outcome(), "not an approved company: the unit is asked");
            var ruleRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.gate.GateResources.UNIT_RULES.table(), app, json);
            as(ownerC, () -> kit.create(ownerC, com.communityos.api.gate.GateResources.UNIT_RULES, ruleRepo, new com.communityos.api.gate.GateResources.UnitRuleFields(unitA, "Allow all", List.of(), null, true, "Deny", false, false, true)));
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> kit.create(ownerC, com.communityos.api.gate.GateResources.UNIT_RULES, ruleRepo, new com.communityos.api.gate.GateResources.UnitRuleFields(unitB, null, List.of(), null, false, null, false, false, true))));
            assertEquals("left", as(admin, () -> gateSvc.delivery(admin, "Rider 3", null, null, "Amazon", new UnitId(unitA), "Main gate", null)).outcome(), "away: left at the gate");
            // household staff from the vetted registry
            var people = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.gate.GateResources.PEOPLE.table(), app, json);
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> kit.create(admin, com.communityos.api.gate.GateResources.PEOPLE, people, new com.communityos.api.gate.GateResources.PersonFields(
                "Lakshmi", "Maid / cook", null, null, "Active", null, null, "Aadhaar", "1234", true, null, null, null, false, false, false, null, false, false, null, null, null))), "cleared without the ID check");
            var maid = as(admin, () -> kit.create(admin, com.communityos.api.gate.GateResources.PEOPLE, people, new com.communityos.api.gate.GateResources.PersonFields(
                "Lakshmi", "Maid / cook", null, null, "Active", null, null, "Aadhaar", "1234", true, null, null, null, true, true, true, null, true, true, null, null, null)));
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> kit.create(ownerC, com.communityos.api.gate.GateResources.PEOPLE, people, new com.communityos.api.gate.GateResources.PersonFields(
                "Raju", "Driver", null, null, "Active", null, null, null, null, true, null, null, null, true, false, false, null, false, false, null, null, null))), "a resident cannot clear anyone");
            var invited = as(ownerC, () -> kit.create(ownerC, com.communityos.api.gate.GateResources.PEOPLE, people, new com.communityos.api.gate.GateResources.PersonFields(
                "Raju", "Driver", null, null, null, null, null, null, null, true, null, null, null, false, false, false, null, false, false, null, null, null)));
            assertEquals("Invited", invited.data().status(), "a resident only invites"); assertFalse(invited.data().idChecked()); assertEquals(unitA, invited.data().invitedByUnitId());
            var links = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.gate.GateResources.LINKS.table(), app, json);
            as(ownerC, () -> kit.create(ownerC, com.communityos.api.gate.GateResources.LINKS, links, new com.communityos.api.gate.GateResources.LinkFields(maid.id(), "Lakshmi", unitA, List.of(), null, null, null)));
            var maidIn = as(admin, () -> gateSvc.admitPerson(admin, maid.id(), "Main gate", "Face", null));
            assertTrue(maidIn.ok(), maidIn.reason()); assertEquals(new UnitId(unitA), maidIn.visit().unit);
            assertEquals("already-inside", as(admin, () -> gateSvc.admitPerson(admin, maid.id(), "Main gate", "Face", null)).outcome());
            var blockedP = as(admin, () -> kit.create(admin, com.communityos.api.gate.GateResources.PEOPLE, people, new com.communityos.api.gate.GateResources.PersonFields(
                "Thief", "Other", null, null, "Blocked", null, null, null, null, false, null, null, null, false, false, false, null, false, false, null, "Theft in 2025", null)));
            assertEquals("blocked", as(admin, () -> gateSvc.admitPerson(admin, blockedP.id(), "Main gate", "Face", null)).outcome());
            // a goods vehicle: one more person than the pass allows is held, then let in with a reason (flagged); one less out is flagged
            var goods = as(ownerC, () -> gateSvc.createPass(ownerC, new com.communityos.api.gate.application.GateService.NewPass("Packers", null, null, "Goods", null, null, null, null, List.of(), "KA05MN1111",
                null, "Move in", 2, "Furniture", false, null, null)));
            assertEquals("headcount", as(admin, () -> gateSvc.admitGoods(admin, goods.id, "Service gate", 3, null, null, null)).outcome());
            var gIn = as(admin, () -> gateSvc.admitGoods(admin, goods.id, "Service gate", 3, null, null, "Helper on board"));
            assertTrue(gIn.ok());
            var gOut = as(admin, () -> gateSvc.exitGoods(admin, gIn.visit().id, gIn.visit().version, 2, false));
            assertEquals(2, gOut.headcountOut.intValue());
            // the minute sweep: an approval nobody answered applies the unit's fallback (Deny)
            var asked2 = as(admin, () -> gateSvc.ask(admin, new com.communityos.api.gate.application.GateService.Ask("Guest", "Unknown caller", null, null, null, null, new UnitId(unitA), "Main gate", null, null, null, null, null)));
            assertEquals("Deny", asked2.approval().fallback, "the unit's own fallback");
            owner.sql("UPDATE gate.approval SET expires_at = now() - interval '1 minute' WHERE id = '" + asked2.approval().id + "' RETURNING 1");
            Caller gateJob = com.communityos.api.shared.security.SystemCaller.of(new CommunityId(cid), "gate sweep");
            assertTrue(as(gateJob, () -> gateSvc.sweep(gateJob)) >= 1);
            assertEquals("Denied", owner.sql("SELECT status FROM gate.approval WHERE id = '" + asked2.approval().id + "'").get(0).get("status"));
            assertEquals("Denied", owner.sql("SELECT state FROM gate.visit WHERE approval_id = '" + asked2.approval().id + "'").get(0).get("state"));
            // patrols: the right code, not too soon
            var cps = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.gate.GateResources.CHECKPOINTS.table(), app, json);
            var cp = as(admin, () -> kit.create(admin, com.communityos.api.gate.GateResources.CHECKPOINTS, cps, new com.communityos.api.gate.GateResources.CheckpointFields("Pump room", "North", 1, true, null)));
            assertTrue(cp.data().code().matches("[A-Z0-9]{10}"), "the server makes the code");
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> gateSvc.scan(admin, "GGCP|" + cp.id() + "|WRONG", null)));
            assertEquals("Pump room", as(admin, () -> gateSvc.scan(admin, "GGCP|" + cp.id() + "|" + cp.data().code(), null)).checkpoint());
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> gateSvc.scan(admin, "GGCP|" + cp.id() + "|" + cp.data().code(), null)), "too soon after the last scan");
            // what each sees
            var flags = as(admin, () -> gateSvc.flags(admin, true));
            assertTrue(flags.stream().map((f) -> f.type).toList().containsAll(List.of("Manual open", "Blocked person attempt", "Headcount mismatch")), flags.stream().map((f) -> f.type).toList().toString());
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> gateSvc.flags(ownerC, false)));
            var resolved = as(admin, () -> gateSvc.resolveFlag(admin, flags.get(0).id, flags.get(0).version, "False alarm", "checked"));
            assertEquals("Closed", resolved.state);
            var mineVisits = as(ownerC, () -> gateSvc.visits(ownerC, new com.communityos.api.gate.application.port.GateStore.VisitFilter(null, null, null, null, false)));
            assertTrue(mineVisits.stream().allMatch((v) -> new UnitId(unitA).equals(v.unit)), "a resident sees their own unit's visits");

            // ---- 6g. notices, notifications, forum ---------------------------------------------------------------------------------------------------------
            var inboxSvc = new com.communityos.api.comms.application.InboxService(inbox);
            var mineNotes = as(ownerC, () -> inboxSvc.mine(ownerC, false, 200));
            List<String> titles = mineNotes.stream().map(com.communityos.api.comms.domain.Comms.Note::title).toList();
            assertTrue(titles.stream().anyMatch((t) -> t.startsWith("New bill")), "bills reach the unit: " + titles);
            assertTrue(titles.stream().anyMatch((t) -> t.equals("At the gate: Ravi Uncle")), "the gate asked the unit: " + titles);
            assertTrue(titles.stream().noneMatch((t) -> t.startsWith("Payment received") || t.startsWith("Booked")), "nobody is told about what they did themselves: " + titles);
            assertTrue(as(plumberC, () -> inboxSvc.mine(plumberC, false, 50)).stream().anyMatch((n) -> n.event().equals("ticket_assigned")), "the assignee hears of the task");
            assertTrue(as(treasurer, () -> inboxSvc.mine(treasurer, false, 200)).stream().noneMatch((n) -> n.title().startsWith("New bill")), "not the treasurer's unit (and they raised it)");
            int unread = as(ownerC, () -> inboxSvc.unread(ownerC));
            assertTrue(unread >= 3);
            assertEquals(1, (int) as(ownerC, () -> inboxSvc.markRead(ownerC, mineNotes.get(0).id())));
            assertEquals(0, (int) as(treasurer, () -> inboxSvc.markRead(treasurer, mineNotes.get(1).id())), "someone else's row is not marked");
            as(ownerC, () -> inboxSvc.markAllRead(ownerC));
            assertEquals(0, (int) as(ownerC, () -> inboxSvc.unread(ownerC)));
            // channels: the owner wants WhatsApp; the community switches WhatsApp off for bills, and adds the super admin to bills
            var prefRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.comms.CommsResources.PREFS.table(), app, json);
            var pref = as(ownerC, () -> kit.create(ownerC, com.communityos.api.comms.CommsResources.PREFS, prefRepo, new com.communityos.api.comms.CommsResources.PrefFields(true, false, true)));
            assertEquals("Member owner", pref.server("userName"));
            assertEquals(0, as(treasurer, () -> kit.list(treasurer, com.communityos.api.comms.CommsResources.PREFS, prefRepo)).size(), "another member's choices are theirs");
            as(treasurer, () -> dueService.raise(treasurer, new DueService.RaiseDue(new UnitId(unitA), "Water", today.withDayOfMonth(1), "Oct", Money.of("100"), today.plusDays(9))));
            var queued = owner.sql("SELECT channel, status, to_value FROM comms.outbox_message WHERE community_id = '" + cid + "' AND membership_id = '" + members[0] + "' AND event = 'bill' ORDER BY channel");
            assertEquals(2, queued.size(), "WhatsApp and e-mail: " + queued);
            assertEquals("Skipped", queued.get(0).get("status"), "no e-mail address on file"); assertEquals("Queued", queued.get(1).get("status")); assertEquals(ownerPhone, queued.get(1).get("to_value"));
            var setRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.comms.CommsResources.SETTINGS.table(), app, json);
            var setting = as(admin, () -> kit.list(admin, com.communityos.api.comms.CommsResources.SETTINGS, setRepo)).get(0);
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> kit.replace(admin, com.communityos.api.comms.CommsResources.SETTINGS, setRepo, setting.id(), setting.version(),
                new com.communityos.api.comms.CommsResources.SettingFields(Map.of("bill", Map.of("fax", true))))));
            as(admin, () -> kit.replace(admin, com.communityos.api.comms.CommsResources.SETTINGS, setRepo, setting.id(), setting.version(),
                new com.communityos.api.comms.CommsResources.SettingFields(Map.of("bill", Map.of("whatsapp", false, "email", false, "alsoRoles", List.of("super_admin"))))));
            as(treasurer, () -> dueService.raise(treasurer, new DueService.RaiseDue(new UnitId(unitA), "Water", today.withDayOfMonth(1), "Oct", Money.of("50"), today.plusDays(9))));
            assertEquals("2", owner.sql("SELECT count(*)::text AS n FROM comms.outbox_message WHERE community_id = '" + cid + "' AND membership_id = '" + members[0] + "' AND event = 'bill'").get(0).get("n"),
                "WhatsApp is switched off for bills now");
            assertTrue(as(admin, () -> inboxSvc.mine(admin, true, 50)).stream().anyMatch((n) -> n.title().equals("New bill · ₹50")), "also told: the super admin");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> kit.create(ownerC, com.communityos.api.comms.CommsResources.NUMBERS,
                new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.comms.CommsResources.NUMBERS.table(), app, json),
                new com.communityos.api.comms.CommsResources.NumberFields("Plumber", "98450 00000", null, null, null, null, true))));
            assertEquals(3, as(ownerC, () -> kit.list(ownerC, com.communityos.api.comms.CommsResources.NUMBERS,
                new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.comms.CommsResources.NUMBERS.table(), app, json))).size(), "police, fire, ambulance");
            var outboxRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.comms.CommsResources.OUTBOX.table(), app, json);
            assertTrue(as(ownerC, () -> kit.list(ownerC, com.communityos.api.comms.CommsResources.OUTBOX, outboxRepo)).isEmpty(), "the queue is the office's");
            assertTrue(as(admin, () -> kit.list(admin, com.communityos.api.comms.CommsResources.OUTBOX, outboxRepo)).size() >= 2, "the office reads it");
            // notices: sent to all residents, read and signed; a committee-only one; a poll per unit; a draft; a scheduled one
            var store = new com.communityos.api.comms.adapter.JdbcCommsStore(app);
            var notices = new com.communityos.api.comms.application.BroadcastService(store, inbox, events, audit, app, clock, ZoneId.of("Asia/Kolkata"));
            java.util.function.BiFunction<String, String, com.communityos.api.comms.application.BroadcastService.Draft> draft = (type, audience) ->
                new com.communityos.api.comms.application.BroadcastService.Draft(type, audience, type + " for " + audience, "<p>Please note.</p>", List.of(), List.of(), null, null, null, null,
                    "Poll".equals(type) ? List.of("Morning", "Evening") : List.of(), false, null, true, null);
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> notices.create(ownerC, draft.apply("Notice", "All residents"), true, null)));
            assertTrue(as(treasurer, () -> notices.reach(treasurer, draft.apply("Notice", "All residents"))) >= 1);
            var sentN = as(treasurer, () -> notices.create(treasurer, draft.apply("Notice", "All residents"), true, null));
            assertEquals("Sent", sentN.status); assertTrue(sentN.recipients >= 1); assertEquals("Member treasurer", sentN.sentBy);
            var seen = as(ownerC, () -> notices.list(ownerC, null));
            assertEquals(List.of(sentN.id), seen.stream().map((b) -> b.id).toList(), "the owner sees what reached them");
            assertTrue(as(ownerC, () -> inboxSvc.mine(ownerC, true, 10)).stream().anyMatch((n) -> n.title().equals("Notice: Notice for All residents")));
            var viewed = as(ownerC, () -> notices.view(ownerC, sentN.id));
            assertNotNull(viewed.viewedAt); assertEquals(1, viewed.viewed); assertTrue(viewed.signedBy.isEmpty(), "readers do not see who signed");
            as(ownerC, () -> notices.sign(ownerC, sentN.id));
            assertEquals(List.of("Member owner"), as(treasurer, () -> notices.get(treasurer, sentN.id)).signedBy);
            var ecOnly = as(treasurer, () -> notices.create(treasurer, draft.apply("Announcement", "EC members"), true, null));
            assertThrows(AccessDenied.NotVisible.class, () -> as(ownerC, () -> notices.get(ownerC, ecOnly.id)));
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> notices.sign(ownerC, ecOnly.id)));
            var poll = as(treasurer, () -> notices.create(treasurer, draft.apply("Poll", "Owners"), true, null));
            var r1 = as(ownerC, () -> notices.vote(ownerC, poll.id, List.of("1"), null));
            assertEquals(List.of(0, 1), r1.counts()); assertEquals(List.of("1"), r1.mine());
            var r2 = as(ownerC, () -> notices.vote(ownerC, poll.id, List.of("0"), null));
            assertEquals(List.of(1, 0), r2.counts()); assertEquals(1, r2.total(), "one answer per unit, changed");
            assertThrows(AccessDenied.class, () -> as(treasurer, () -> notices.vote(treasurer, poll.id, List.of("0"), null)), "not an owner: the poll did not reach them");
            assertEquals("Villa 101", as(treasurer, () -> notices.voters(treasurer, poll.id)).get(0).unitNo());
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> notices.voters(ownerC, poll.id)));
            var dr = as(treasurer, () -> notices.create(treasurer, draft.apply("Announcement", "All residents"), false, null));
            assertEquals("Draft", dr.status); assertEquals(0, dr.recipients);
            assertThrows(AccessDenied.NotVisible.class, () -> as(ownerC, () -> notices.get(ownerC, dr.id)), "a draft is the committee's");
            as(treasurer, () -> { notices.remove(treasurer, dr.id, dr.version); return null; });
            assertThrows(DomainException.RuleViolated.class, () -> as(treasurer, () -> { notices.remove(treasurer, sentN.id, notices.get(treasurer, sentN.id).version); return null; }), "a sent notice stays");
            var liftNotice = as(treasurer, () -> notices.create(treasurer, new com.communityos.api.comms.application.BroadcastService.Draft("Scheduled maintenance", "Selected blocks", "Lift service",
                "<p>Lift off</p>", List.of(), List.of(b1), today.plusDays(2), "10:00", "12:00", "Lift", List.of(), false, null, false, null), false, clock.instant().plusSeconds(3600)));
            assertEquals("Scheduled", liftNotice.status);
            owner.sql("UPDATE comms.broadcast SET scheduled_for = now() - interval '1 minute' WHERE id = '" + liftNotice.id + "' RETURNING 1");
            Caller noticeJob = com.communityos.api.shared.security.SystemCaller.of(new CommunityId(cid), "scheduled notices");
            assertEquals(1, (int) as(noticeJob, () -> notices.sendDue(noticeJob)));
            var lift = as(treasurer, () -> notices.get(treasurer, liftNotice.id));
            assertEquals("Sent", lift.status); assertEquals(1, lift.recipients, "Block 1 is Villa 101 only");
            var moved = as(treasurer, () -> notices.reschedule(treasurer, liftNotice.id, lift.version, today.plusDays(3), "14:00", "16:00"));
            assertEquals("14:00", moved.startTime);
            assertTrue(as(ownerC, () -> inboxSvc.mine(ownerC, true, 10)).stream().anyMatch((n) -> n.title().startsWith("RESCHEDULED - Lift service")));
            // the forum: a topic, a reply that tells the author, moderation, a topic poll
            var forum = new com.communityos.api.comms.application.ForumService(store, inbox, events, audit, app, clock);
            var topic = as(ownerC, () -> forum.start(ownerC, new com.communityos.api.comms.application.ForumService.NewTopic("Pool timings in winter", "Amenities", "Poll", List.of("6-9", "7-10"))));
            assertEquals("Member owner", topic.author); assertEquals(0, topic.replies);
            var reply = as(treasurer, () -> forum.reply(treasurer, topic.id, null, "<p>7-10 please</p>"));
            assertEquals("Member treasurer", reply.author); assertEquals("treasurer", reply.authorRole);
            assertTrue(as(ownerC, () -> inboxSvc.mine(ownerC, true, 10)).stream().anyMatch((n) -> n.event().equals("forum_reply")), "the author hears of the reply");
            var t1 = as(ownerC, () -> forum.topic(ownerC, topic.id));
            assertEquals(1, t1.replies, "counted by the server");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> forum.change(ownerC, topic.id, t1.version, new com.communityos.api.comms.application.ForumService.TopicChange(null, null, true, null))));
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> forum.edit(ownerC, reply.id, reply.version, "changed")), "not their post");
            var hidden = as(admin, () -> forum.hide(admin, reply.id, reply.version, true, "Off topic"));
            assertTrue(hidden.hidden);
            assertEquals("", as(ownerC, () -> forum.posts(ownerC, topic.id)).get(0).body, "a hidden post keeps its place, not its words");
            assertEquals("<p>7-10 please</p>", as(treasurer, () -> forum.posts(treasurer, topic.id)).get(0).body, "its author still reads it");
            assertEquals(0, as(ownerC, () -> forum.topic(ownerC, topic.id)).replies);
            var tv = as(ownerC, () -> forum.vote(ownerC, topic.id, 1));
            assertEquals(List.of(0, 1), tv.counts());
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> forum.vote(ownerC, topic.id, 0)), "one vote per person");
            var pinned = as(admin, () -> forum.change(admin, topic.id, forum.topic(admin, topic.id).version, new com.communityos.api.comms.application.ForumService.TopicChange(null, null, true, "Closed")));
            assertTrue(pinned.pinned); assertEquals("Closed", pinned.status);
            assertThrows(DomainException.RuleViolated.class, () -> as(treasurer, () -> forum.reply(treasurer, topic.id, null, "late")), "closed");

            // ---- 6h. files and documents: a photo on a ticket, documents by group, a folder limited to a role, refusals -----------------------------------
            var fileRepo = new com.communityos.api.docs.adapter.JdbcFileRepository(app);
            var disk = new com.communityos.api.docs.adapter.LocalDiskStorage(java.nio.file.Files.createTempDirectory("cos-flow-files"));
            var fileSvc = new com.communityos.api.docs.application.FileService(fileRepo, disk, com.communityos.api.docs.application.port.VirusScanner.NONE, audit, app, clock);
            var docSvc = new com.communityos.api.docs.application.DocumentService(new com.communityos.api.docs.adapter.JdbcDocumentRepository(app), fileSvc, audit, app);
            com.communityos.api.config.FileKinds.register(fileSvc, fileRepo, ticketSvc, docsSvc, bookingSvc, docSvc);
            byte[] png = {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52};
            byte[] pdfBytes = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1);
            var photo = as(ownerC, () -> fileSvc.upload(ownerC, new com.communityos.api.docs.application.FileService.Upload("../leak.png", png, null)));
            assertEquals("leak.png", photo.fileName()); assertEquals("image/png", photo.mimeType()); assertEquals(64, photo.sha256().length()); assertEquals("Member owner", photo.uploadedBy());
            assertThrows(AccessDenied.NotVisible.class, () -> as(treasurer, () -> fileSvc.get(treasurer, photo.id())), "not attached yet: only its uploader");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> fileSvc.attach(ownerC, photo.id(), "amenity.booking", booked.id())), "deposit photos are the amenities staff's");
            as(ownerC, () -> fileSvc.attach(ownerC, photo.id(), "maintenance.ticket", leak.id()));
            assertTrue(java.util.Arrays.equals(png, as(treasurer, () -> fileSvc.content(treasurer, photo.id())).bytes()), "now whoever sees the ticket opens it");
            assertEquals(1, as(admin, () -> fileSvc.list(admin, "maintenance.ticket", leak.id())).size());
            assertEquals(List.of(photo.id()), as(ownerC, () -> fileSvc.list(ownerC, "maintenance.ticket", null)).stream().map((f) -> f.id()).toList());
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> fileSvc.upload(ownerC, new com.communityos.api.docs.application.FileService.Upload("x.txt",
                "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*".getBytes(), null))), "the test virus");
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> fileSvc.upload(ownerC, new com.communityos.api.docs.application.FileService.Upload("x.jpg", pdfBytes, null))), "not what it says");
            var pdf1 = as(admin, () -> fileSvc.upload(admin, new com.communityos.api.docs.application.FileService.Upload("bye-laws.pdf", pdfBytes, null)));
            var fields = new com.communityos.api.docs.application.DocumentService.Fields("Bye-laws", "Association", "v3", "All owners", null, null, null);
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> docSvc.file(ownerC, pdf1.id(), fields)));
            var byelaws = as(admin, () -> docSvc.file(admin, pdf1.id(), fields));
            assertEquals("bye-laws.pdf", byelaws.fileName); assertEquals("v3", byelaws.edition); assertEquals("docs.document", as(admin, () -> fileSvc.get(admin, pdf1.id())).ownerType());
            assertEquals(List.of("Bye-laws"), as(ownerC, () -> docSvc.list(ownerC, new com.communityos.api.docs.application.port.DocumentRepository.Filter(null, null, null))).stream().map((d) -> d.title).toList());
            assertTrue(java.util.Arrays.equals(pdfBytes, as(ownerC, () -> fileSvc.content(ownerC, pdf1.id())).bytes()), "an owner opens an owners' document");
            var pdf2 = as(admin, () -> fileSvc.upload(admin, new com.communityos.api.docs.application.FileService.Upload("deed.pdf", pdfBytes, null)));
            var deed = as(admin, () -> docSvc.file(admin, pdf2.id(), new com.communityos.api.docs.application.DocumentService.Fields("Sale deed", "Villa document", null, "Villa owner / resident", unitB, null, null)));
            assertThrows(AccessDenied.NotVisible.class, () -> as(ownerC, () -> docSvc.get(ownerC, deed.id)), "another villa's papers");
            assertThrows(AccessDenied.NotVisible.class, () -> as(ownerC, () -> fileSvc.content(ownerC, pdf2.id())), "and their file");
            var folderRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.docs.DocsResources.FOLDERS.table(), app, json);
            var treasury = as(admin, () -> kit.create(admin, com.communityos.api.docs.DocsResources.FOLDERS, folderRepo, new com.communityos.api.docs.DocsResources.FolderFields("Treasury", null, List.of("treasurer"))));
            var inner = as(admin, () -> kit.create(admin, com.communityos.api.docs.DocsResources.FOLDERS, folderRepo, new com.communityos.api.docs.DocsResources.FolderFields("2026", treasury.id(), List.of())));
            var pdf3 = as(admin, () -> fileSvc.upload(admin, new com.communityos.api.docs.application.FileService.Upload("budget.pdf", pdfBytes, null)));
            var budget = as(admin, () -> docSvc.file(admin, pdf3.id(), new com.communityos.api.docs.application.DocumentService.Fields("Budget", null, null, "Everyone", null, null, inner.id())));
            assertTrue(as(ownerC, () -> kit.list(ownerC, com.communityos.api.docs.DocsResources.FOLDERS, folderRepo)).isEmpty(), "the limit holds below the folder");
            assertThrows(AccessDenied.NotVisible.class, () -> as(ownerC, () -> docSvc.get(ownerC, budget.id)), "even an 'Everyone' document in it");
            assertEquals("Budget", as(treasurer, () -> docSvc.get(treasurer, budget.id)).title);
            var hidden2 = as(admin, () -> docSvc.change(admin, byelaws.id, byelaws.version, new com.communityos.api.docs.application.DocumentService.Fields("Bye-laws", "Association", "v4", "Executive Committee", null, null, null)));
            assertEquals("v4", hidden2.edition);
            assertTrue(as(ownerC, () -> docSvc.list(ownerC, new com.communityos.api.docs.application.port.DocumentRepository.Filter(null, null, null))).isEmpty());
            var scrap = as(ownerC, () -> fileSvc.upload(ownerC, new com.communityos.api.docs.application.FileService.Upload("scrap.pdf", pdfBytes, null)));
            as(ownerC, () -> { fileSvc.delete(ownerC, scrap.id()); return null; });
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> { fileSvc.delete(ownerC, photo.id()); return null; }), "attached: a manager removes it");

            // ---- 6i. cultural: an event through the kit, pledges and receipts in the books, an online donation, a fixed offering, seva sign-ups, expenses -------
            var cstore = new com.communityos.api.cultural.adapter.JdbcCulturalStore(app, new com.communityos.api.approval.application.PlanCodec(json), json);
            var cdesk = new com.communityos.api.billing.application.BillingDesk(payments, new com.communityos.api.billing.application.TargetSettlement(dues, payments, events, audit, app, clock),
                new JdbcJournalWriter(app), events, clock);
            var donSvc = new com.communityos.api.cultural.application.DonationService(cstore, cdesk, events, audit, app, clock, ZoneId.of("Asia/Kolkata"));
            var expSvc = new com.communityos.api.cultural.application.ExpenseService(cstore, new com.communityos.api.approval.adapter.JdbcApprovalSettings(app, json), cdesk, events, audit, app, clock, ZoneId.of("Asia/Kolkata"));
            var signSvc = new com.communityos.api.cultural.application.SignupService(cstore, audit, app);
            var evRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.cultural.CulturalResources.EVENTS.table(), app, json);
            java.util.function.Function<String, com.communityos.api.cultural.CulturalResources.EventFields> evf = (status) -> new com.communityos.api.cultural.CulturalResources.EventFields(
                "Diwali Festival", "Festival", LocalDate.of(2026, 11, 8), LocalDate.of(2026, 11, 9), null, null, null, null, "Clubhouse", status, "Published", null, null, new java.math.BigDecimal("50000"),
                null, null, null, "Cultural", new java.math.BigDecimal("5000"), null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null);
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> kit.create(ownerC, com.communityos.api.cultural.CulturalResources.EVENTS, evRepo, evf.apply("Open"))));
            var diwali = as(admin, () -> kit.create(admin, com.communityos.api.cultural.CulturalResources.EVENTS, evRepo, evf.apply("Open")));
            com.communityos.api.cultural.application.DonationService.Pledge base = new com.communityos.api.cultural.application.DonationService.Pledge(diwali.id(), null, null, null, null,
                new java.math.BigDecimal("1001"), null, null, null, false, null, null, null, null, null);
            var p1 = as(ownerC, () -> donSvc.pledge(ownerC, base));
            assertEquals("Pledged", p1.status); assertEquals(unitA, p1.unitId); assertEquals("Member owner", p1.donor); assertNull(p1.receiptNo);
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> donSvc.pledge(ownerC, new com.communityos.api.cultural.application.DonationService.Pledge(diwali.id(), null, unitB, null, null,
                java.math.BigDecimal.TEN, null, null, null, false, null, null, null, null, null))), "only for their own unit");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> donSvc.receive(ownerC, p1.id, p1.version, "Cash", null)), "the committee confirms receipt");
            var dr1 = as(admin, () -> donSvc.receive(admin, p1.id, p1.version, "Cash", null));
            assertEquals("DF26-0001", dr1.receiptNo); assertEquals("Received", dr1.status); assertNotNull(dr1.paymentId);
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> { donSvc.withdraw(ownerC, dr1.id, dr1.version); return null; }), "a receipt is final");
            assertTrue(as(ownerC, () -> inboxSvc.mine(ownerC, true, 20)).stream().anyMatch((n) -> n.title().equals("Receipt DF26-0001")));
            // online: a prepayment for a donation, claimed by the pledge
            var p2 = as(ownerC, () -> donSvc.pledge(ownerC, new com.communityos.api.cultural.application.DonationService.Pledge(diwali.id(), null, null, "Donation", "Charity",
                new java.math.BigDecimal("2500"), null, null, null, true, null, null, null, null, null)));
            PaymentService.OrderView dpre = as(ownerC, () -> pay.createOrder(ownerC, new PaymentService.CreateOrder(List.of(), "donation", new UnitId(unitA), Money.of("2500")), "it-don-" + tag));
            Map<String, String> dPaid = sim.simulatePay(dpre.order().providerOrderRef(), true);
            PaymentRepository.Receipt dR = as(ownerC, () -> pay.confirm(ownerC, dpre.order().id(), dPaid.get("providerPaymentRef"), dPaid.get("signature")));
            var dr2 = as(ownerC, () -> donSvc.paidOnline(ownerC, p2.id, p2.version, dR.id().value()));
            assertEquals("DF26-0002", dr2.receiptNo); assertEquals("Online", dr2.mode);
            var p2b = as(ownerC, () -> donSvc.pledge(ownerC, base));
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> donSvc.paidOnline(ownerC, p2b.id, p2b.version, dR.id().value())), "a prepayment is used once");
            as(ownerC, () -> { donSvc.withdraw(ownerC, p2b.id, p2b.version); return null; });
            var visitor = as(admin, () -> donSvc.record(admin, new com.communityos.api.cultural.application.DonationService.Pledge(diwali.id(), "A visitor", null, null, null,
                new java.math.BigDecimal("500"), null, "Cash", null, false, null, null, null, null, null), true));
            assertEquals("DF26-0003", visitor.receiptNo);
            assertEquals("4001.00", owner.sql("SELECT coalesce(sum(l.credit), 0)::text AS c FROM finance.journal_line l JOIN finance.account a ON a.id = l.account_id WHERE l.community_id = '" + cid + "' AND a.code = '4400'").get(0).get("c"),
                "1001 + 2500 + 500 in Donations");
            assertEquals(2, as(ownerC, () -> donSvc.list(ownerC, diwali.id())).size(), "the owner sees their unit's donations, not the visitor's");
            // a fixed offering slot: one pledge holds it
            var offRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.cultural.CulturalResources.OFFERINGS.table(), app, json);
            var abhi = as(admin, () -> kit.create(admin, com.communityos.api.cultural.CulturalResources.OFFERINGS, offRepo, new com.communityos.api.cultural.CulturalResources.OfferingFields(
                diwali.id(), "Abhishekam", "Day 1", "Fixed slot", new java.math.BigDecimal("5001"), null)));
            var held = as(ownerC, () -> donSvc.pledge(ownerC, new com.communityos.api.cultural.application.DonationService.Pledge(diwali.id(), null, null, null, null, new java.math.BigDecimal("5001"),
                null, null, null, false, null, null, null, null, abhi.id())));
            assertEquals("Seva offering", held.towards);
            assertEquals(String.valueOf(held.id), String.valueOf(as(admin, () -> kit.get(admin, com.communityos.api.cultural.CulturalResources.OFFERINGS, offRepo, abhi.id())).server("donationId")));
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> donSvc.record(admin, new com.communityos.api.cultural.application.DonationService.Pledge(diwali.id(), "Someone", null, null, null,
                new java.math.BigDecimal("5001"), null, "Cash", null, false, null, null, null, null, abhi.id()), true)), "already reserved");
            as(ownerC, () -> { donSvc.withdraw(ownerC, held.id, held.version); return null; });
            assertNull(as(admin, () -> kit.get(admin, com.communityos.api.cultural.CulturalResources.OFFERINGS, offRepo, abhi.id())).server("donationId"), "free again");
            // seva: one volunteer needed
            var sevaRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.cultural.CulturalResources.SEVAS.table(), app, json);
            var stall = as(admin, () -> kit.create(admin, com.communityos.api.cultural.CulturalResources.SEVAS, sevaRepo, new com.communityos.api.cultural.CulturalResources.SevaFields(diwali.id(),
                "Prasadam stall", LocalDate.of(2026, 11, 8), null, null, 1, null)));
            var seva1 = as(ownerC, () -> signSvc.signUp(ownerC, com.communityos.api.cultural.application.port.CulturalStore.List_.SEVA, stall.id(), null));
            assertEquals(1, seva1.list().size()); assertEquals("Villa 101", seva1.list().get(0).unit());
            assertEquals("full", assertThrows(DomainException.RuleViolated.class, () -> as(treasurer, () -> signSvc.signUp(treasurer, com.communityos.api.cultural.application.port.CulturalStore.List_.SEVA, stall.id(), null))).code());
            assertThrows(AccessDenied.class, () -> as(treasurer, () -> signSvc.withdraw(treasurer, com.communityos.api.cultural.application.port.CulturalStore.List_.SEVA, stall.id(), members[0])), "not theirs to remove");
            as(ownerC, () -> signSvc.withdraw(ownerC, com.communityos.api.cultural.application.port.CulturalStore.List_.SEVA, stall.id(), null));
            assertEquals(1, as(treasurer, () -> signSvc.signUp(treasurer, com.communityos.api.cultural.application.port.CulturalStore.List_.SEVA, stall.id(), null)).list().size());
            // expenses: under the event's limit the EC's approval is the last step; over it, a final approver too; paid, it is in the books
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> expSvc.raise(ownerC, diwali.id(), new com.communityos.api.cultural.application.ExpenseService.Fields("Flowers", null, null, null, java.math.BigDecimal.TEN, null, null, null))));
            var flowers = as(admin, () -> expSvc.raise(admin, diwali.id(), new com.communityos.api.cultural.application.ExpenseService.Fields("Flowers", "Decoration", "Ganesh Florist", new java.math.BigDecimal("3000"), null, today, "Cultural", null)));
            assertEquals("Pending approval", flowers.status); assertEquals(Boolean.FALSE, flowers.finalRequired == null ? Boolean.FALSE : flowers.finalRequired);
            var fOk = as(treasurer, () -> expSvc.decide(treasurer, flowers.id, flowers.version, "Approved", null, false));
            assertEquals("Approved", fOk.status, "under the limit: the EC is the last step"); assertEquals("Member treasurer", fOk.ecApprovedBy);
            var paidX = as(treasurer, () -> expSvc.pay(treasurer, fOk.id, fOk.version, "Bank transfer"));
            assertEquals("Paid", paidX.status);
            assertEquals("3000.00", owner.sql("SELECT coalesce(sum(l.debit), 0)::text AS d FROM finance.journal_line l JOIN finance.account a ON a.id = l.account_id WHERE l.community_id = '" + cid + "' AND a.code = '5100'").get(0).get("d"));
            var sound = as(admin, () -> expSvc.raise(admin, diwali.id(), new com.communityos.api.cultural.application.ExpenseService.Fields("Sound system", null, null, new java.math.BigDecimal("8000"), null, today, null, null)));
            var sEc = as(treasurer, () -> expSvc.decide(treasurer, sound.id, sound.version, "Approved", null, false));
            assertEquals("Pending approval", sEc.status); assertEquals("Approved", sEc.ecApproval); assertEquals(Boolean.TRUE, sEc.finalRequired, "over the limit: a final approver too");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> expSvc.decide(ownerC, sound.id, sEc.version, "Approved", null, false)));
            assertThrows(DomainException.RuleViolated.class, () -> as(treasurer, () -> expSvc.pay(treasurer, sound.id, sEc.version, null)), "not approved yet");
            // the event's totals are worked out from the rows
            var after = as(ownerC, () -> kit.get(ownerC, com.communityos.api.cultural.CulturalResources.EVENTS, evRepo, diwali.id()));
            assertEquals(0, new java.math.BigDecimal("4001").compareTo(new java.math.BigDecimal(String.valueOf(after.server("collected")))), "collected: " + after.server("collected"));
            assertEquals(0, new java.math.BigDecimal("3000").compareTo(new java.math.BigDecimal(String.valueOf(after.server("spent")))), "spent counts approved and paid");
            // the unused budget is credited back once the event is completed
            var cur = as(admin, () -> kit.get(admin, com.communityos.api.cultural.CulturalResources.EVENTS, evRepo, diwali.id()));
            assertThrows(DomainException.RuleViolated.class, () -> as(treasurer, () -> expSvc.credit(treasurer, diwali.id(), cur.version(), new java.math.BigDecimal("1000"), null)), "not completed yet");
            var evDone = as(admin, () -> kit.replace(admin, com.communityos.api.cultural.CulturalResources.EVENTS, evRepo, diwali.id(), cur.version(), evf.apply("Completed")));
            assertThrows(DomainException.RuleViolated.class, () -> as(treasurer, () -> expSvc.credit(treasurer, diwali.id(), evDone.version(), new java.math.BigDecimal("60000"), null)), "more than unused");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> expSvc.credit(ownerC, diwali.id(), evDone.version(), new java.math.BigDecimal("1000"), null)));
            var credited = as(treasurer, () -> expSvc.credit(treasurer, diwali.id(), evDone.version(), new java.math.BigDecimal("47000"), "back to the Cultural fund"));
            assertEquals(0, new java.math.BigDecimal("47000").compareTo(credited.creditedAmount()));
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> donSvc.pledge(ownerC, base)), "a completed event takes no pledges");

            // ---- 7. audit, outbox ----------------------------------------------------------------------------------------------------------------
            assertTrue(Integer.parseInt((String) owner.sql("SELECT count(*)::text AS n FROM audit.audit_event WHERE community_id = '" + cid + "'").get(0).get("n")) >= 7);
            OutboxRelay relay = new OutboxRelay(new JdbcOutboxStore(platform), new WebhookFanout(platform), 10, clock);
            int sent = 0; for (int i = 0; i < 20; i++) { int n = relay.runOnce(200); sent += n; if (n == 0) break; }
            assertEquals("0", owner.sql("SELECT count(*)::text AS n FROM integration.outbox_event WHERE community_id = '" + cid + "' AND status = 'Pending'").get(0).get("n"), "all relayed");
            assertTrue(sent >= 8);

            // ---- 8. another community sees nothing of this one ----------------------------------------------------------------------------------
            Caller stranger = new Caller(new PersonId(UUID.randomUUID()), new MembershipId(UUID.randomUUID()), new CommunityId(other), "x", Caller.Category.EC, java.util.Set.of("super_admin"),
                java.util.Set.of(), java.util.Set.of(), java.util.Set.of(), null, java.util.Set.of());
            assertThrows(AccessDenied.NotVisible.class, () -> as(stranger, () -> dueService.get(stranger, a1.id())), "row-level security, not just the access spec");
            assertThrows(AccessDenied.NotVisible.class, () -> as(stranger, () -> ticketSvc.get(stranger, leak.id())), "and for tickets");
            assertEquals(0, as(stranger, () -> dueService.list(stranger, new DueRepository.Filter(null, null, null, null, null, false), PageQuery.of(50, 0))).total());
            assertThrows(RuntimeException.class, () -> as(stranger, () -> dueService.raise(stranger, new DueService.RaiseDue(new UnitId(unitA), "Maintenance", null, null, Money.of("1"), today))),
                "cannot bill another community's unit");
            assertEquals(otherUnit, as(stranger, () -> units.get(stranger, new UnitId(otherUnit))).id().value());
            System.out.println("flow: " + (app.statements + platform.statements) + " statements through cos_app / cos_platform");
        }
    }
    static UUID id(PsqlJdbc s, String sql) { return UUID.fromString((String) s.sql(sql).get(0).get("id")); }
}
