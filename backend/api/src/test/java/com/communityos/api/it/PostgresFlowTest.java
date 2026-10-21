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
            DomainEvents events = new DomainEvents(new LedgerPoster(new JdbcJournalWriter(app), ZoneId.of("Asia/Kolkata")).handlers(), new JdbcOutboxWriter(app, json));
            JdbcAuditWriter audit = new JdbcAuditWriter(app, json);
            JdbcDueRepository dues = new JdbcDueRepository(app); JdbcBillingLookups lookups = new JdbcBillingLookups(app);
            JdbcPaymentOrderRepository orders = new JdbcPaymentOrderRepository(app); JdbcPaymentRepository payments = new JdbcPaymentRepository(app);
            SimulatedGateway sim = new SimulatedGateway("sim-secret");
            GatewaySettlement gs = new GatewaySettlement(dues, payments, events, audit, app, orders, clock);
            CounterSettlement counter = new CounterSettlement(dues, payments, events, audit, app, lookups, clock);
            JdbcPlatformPayments pp = new JdbcPlatformPayments(platform);
            PaymentService pay = new PaymentService(dues, orders, new GatewayRegistry(List.of(sim), "simulated"), gs, pp, pp, events, app, clock, Duration.ofMinutes(30), "INR");
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
            com.communityos.api.maintenance.application.TicketService ticketSvc = new com.communityos.api.maintenance.application.TicketService(
                new com.communityos.api.maintenance.adapter.JdbcTicketRepository(app, json), mdir, mdir, events, audit, app, clock);
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
