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
import java.nio.charset.StandardCharsets;
import com.communityos.api.shared.http.HttpTransport;
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
    /** What the phone does with a Web Push message (RFC 8291 / RFC 8188, one record): proves only that phone can read it. */
    static byte[] decryptPush(byte[] body, java.security.interfaces.ECPrivateKey uaPriv, java.security.interfaces.ECPublicKey uaPub, byte[] auth) throws Exception {
        java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(body);
        byte[] salt = new byte[16]; b.get(salt); int rs = b.getInt(); byte[] asRaw = new byte[b.get() & 0xff]; b.get(asRaw);
        byte[] ct = new byte[b.remaining()]; b.get(ct);
        assertEquals(4096, rs);
        var ka = javax.crypto.KeyAgreement.getInstance("ECDH"); ka.init(uaPriv); ka.doPhase(com.communityos.api.shared.push.WebPush.publicKey(asRaw), true);
        byte[] ecdh = ka.generateSecret();
        java.util.function.BiFunction<byte[], byte[], byte[]> hmac = (k, d) -> {
            try { var m = javax.crypto.Mac.getInstance("HmacSHA256"); m.init(new javax.crypto.spec.SecretKeySpec(k, "HmacSHA256")); return m.doFinal(d); } catch (Exception e) { throw new IllegalStateException(e); }
        };
        java.io.ByteArrayOutputStream info = new java.io.ByteArrayOutputStream();
        info.write("WebPush: info\0".getBytes(StandardCharsets.US_ASCII)); info.write(com.communityos.api.shared.push.WebPush.raw(uaPub)); info.write(asRaw); info.write(1);
        byte[] ikm = hmac.apply(hmac.apply(auth, ecdh), info.toByteArray());
        byte[] prk = hmac.apply(salt, ikm);
        byte[] cek = java.util.Arrays.copyOf(hmac.apply(prk, "Content-Encoding: aes128gcm\0\1".getBytes(StandardCharsets.US_ASCII)), 16);
        byte[] nonce = java.util.Arrays.copyOf(hmac.apply(prk, "Content-Encoding: nonce\0\1".getBytes(StandardCharsets.US_ASCII)), 12);
        var gcm = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        gcm.init(javax.crypto.Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(cek, "AES"), new javax.crypto.spec.GCMParameterSpec(128, nonce));
        byte[] plain = gcm.doFinal(ct);
        int end = plain.length - 1; while (end >= 0 && plain[end] == 0) end--;
        assertEquals(2, plain[end], "the last record's delimiter");
        return java.util.Arrays.copyOf(plain, end);
    }

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
            Clock clock = new com.communityos.api.demo.ReplayClock(Clock.system(ZoneId.of("Asia/Kolkata")));   // as with the demo on: the loader replays the sample data at its own times
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
            List<com.communityos.api.shared.events.DomainEventHandler<?>> handlers = new ArrayList<>(new LedgerPoster(new JdbcJournalWriter(app), clock).handlers());
            handlers.add(new com.communityos.api.comms.application.Notifier(inbox, inbox));   // every event below also lands in the inboxes
            DomainEvents events = new DomainEvents(handlers, new JdbcOutboxWriter(app, json));
            JdbcAuditWriter audit = new JdbcAuditWriter(app, json);
            JdbcDueRepository dues = new JdbcDueRepository(app); JdbcBillingLookups lookups = new JdbcBillingLookups(app);
            JdbcPaymentOrderRepository orders = new JdbcPaymentOrderRepository(app); JdbcPaymentRepository payments = new JdbcPaymentRepository(app);
            SimulatedGateway sim = new SimulatedGateway("sim-secret", clock, Duration.ofSeconds(30), Duration.ofSeconds(20));
            GatewaySettlement gs = new GatewaySettlement(dues, payments, events, audit, app, orders, clock);
            CounterSettlement counter = new CounterSettlement(dues, payments, events, audit, app, lookups, clock);
            JdbcPlatformPayments pp = new JdbcPlatformPayments(platform);
            PaymentService pay = new PaymentService(dues, payments, orders, new GatewayRegistry(List.of(sim), "simulated"), gs, pp, pp, events, app, clock, Duration.ofMinutes(30), "INR");
            DueService dueService = new DueService(dues, lookups, lookups, events, audit, app, clock);
            UnitService units = new UnitService(new JdbcUnitRepository(app, json), new CustomFields(new JdbcFieldDefinitions(app)), audit, app, new com.communityos.api.property.adapter.JdbcPropertySetup(app, json));
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
            // the simulated bank, as a real one behaves: declined (only the webhook says so), slow (charged later), confirmation lost (the webhook settles it)
            List<com.communityos.api.billing.domain.Due> simBills = new java.util.ArrayList<>();
            java.util.function.Function<String, PaymentService.OrderView> billAndOrder = (k) -> {
                var bill = as(treasurer, () -> dueService.raise(treasurer, new DueService.RaiseDue(new UnitId(unitA), "Water", today.withDayOfMonth(1), "Sim " + k, Money.of("120"), today.plusDays(9))));
                simBills.add(bill);
                return as(ownerC, () -> pay.createOrder(ownerC, new PaymentService.CreateOrder(List.of(bill.id())), "it-sim-" + k + "-" + tag));
            };
            Runnable bank = () -> { for (var hk : sim.dueWebhooks()) pay.webhook("simulated", hk.getKey(), hk.getValue()); };
            java.util.function.Function<PaymentService.OrderView, String> statusOf = (o) -> (String) owner.sql("SELECT status FROM billing.payment_order WHERE id = '" + o.order().id() + "'").get(0).get("status");
            var declined = billAndOrder.apply("fail"); sim.simulate(declined.order().providerOrderRef(), SimulatedGateway.Outcome.FAILURE); bank.run();
            assertEquals("Failed", statusOf.apply(declined), "a declined card fails the order");
            var slow = billAndOrder.apply("slow"); sim.simulate(slow.order().providerOrderRef(), SimulatedGateway.Outcome.PENDING); bank.run();
            assertTrue(!"Paid".equals(statusOf.apply(slow)), "the bank has not charged yet");
            var lost = billAndOrder.apply("lost"); sim.simulate(lost.order().providerOrderRef(), SimulatedGateway.Outcome.LOST); bank.run();
            assertTrue(!"Paid".equals(statusOf.apply(lost)), "the app never confirmed; the webhook is still on its way");
            com.communityos.api.demo.ReplayClock.at(java.time.Instant.now().plusSeconds(31), () -> { bank.run(); return null; });
            assertEquals("Paid", statusOf.apply(slow), "the slow bank charged, its webhook settled the order");
            assertEquals("Paid", statusOf.apply(lost), "the lost confirmation was made good by the webhook");
            as(treasurer, () -> counter.settle(treasurer, new CounterSettlement.Request(new UnitId(unitA), simBills.get(0).amount().plus(simBills.get(0).tax()), "Cash", today,
                List.of(simBills.get(0).id()), "paid in cash after the card was declined")));

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
                    new com.communityos.api.billing.application.TargetSettlement(dues, payments, events, audit, app, clock), new JdbcJournalWriter(app), events, clock), clock),
                events, audit, app, clock);
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
            // a booking paid online, cancelled in time: the fee and deposit go back through the payment provider - pending, then processed by its webhook
            var refundSvc = new com.communityos.api.billing.application.RefundService(new com.communityos.api.billing.adapter.JdbcRefunds(app, platform),
                new com.communityos.api.billing.adapter.JdbcRefunds(app, platform), new GatewayRegistry(List.of(sim), "simulated"), audit, app, clock);
            pay.refunds(refundSvc); bookingSvc.refunds(refundSvc);
            Runnable simBank = () -> { for (var hk : sim.dueWebhooks()) pay.webhook("simulated", hk.getKey(), hk.getValue()); };
            java.util.function.Function<LocalDate, com.communityos.api.amenity.domain.Booking> paidOnline = (day) -> {
                PaymentService.OrderView o = as(ownerC, () -> pay.createOrder(ownerC, new PaymentService.CreateOrder(List.of(), "booking", new UnitId(unitA), Money.of("7900")), "it-rf-" + day + "-" + tag));
                Map<String, String> pd = sim.simulatePay(o.order().providerOrderRef(), true);
                PaymentRepository.Receipt rc = as(ownerC, () -> pay.confirm(ownerC, o.order().id(), pd.get("providerPaymentRef"), pd.get("signature")));
                var bk = as(ownerC, () -> bookingSvc.book(ownerC, new com.communityos.api.amenity.application.BookingService.Book(hallItem.id(), new UnitId(unitA), day, null, "UPI",
                    rc.id().value(), false, "Unit", null, false, null, Map.of())));
                return as(admin, () -> bookingSvc.cancel(admin, bk.id(), bk.version(), new com.communityos.api.amenity.application.BookingService.Cancel("Plans changed", false, false, null)));
            };
            var toRefund = paidOnline.apply(today.plusDays(20));
            assertEquals("Refund due", toRefund.state().refundStatus); assertEquals("7900.00", toRefund.state().refundAmount.toPlainString(), "in time: the fee and the deposit");
            var rfAsked = as(admin, () -> bookingSvc.initiateRefund(admin, toRefund.id(), toRefund.version(), "fee"));
            assertEquals("Refund initiated", rfAsked.state().refundStatus); assertTrue(rfAsked.state().refundRef.startsWith("RFD-"));
            simBank.run();
            assertEquals("Refund initiated", as(admin, () -> bookingSvc.get(admin, toRefund.id())).state().refundStatus, "the bank has not sent it back yet");
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> bookingSvc.initiateRefund(admin, toRefund.id(), rfAsked.version(), "fee")), "asked once");
            com.communityos.api.demo.ReplayClock.at(java.time.Instant.now().plusSeconds(61), () -> { simBank.run(); return null; });
            var refunded = as(admin, () -> bookingSvc.get(admin, toRefund.id()));
            assertEquals("Refunded", refunded.state().refundStatus); assertEquals("Refunded", refunded.state().paymentStatus); assertTrue(refunded.state().refundRef.startsWith("sim_rfnd_"));
            assertEquals("Processed", owner.sql("SELECT status FROM billing.gateway_refund WHERE community_id = '" + cid + "' AND owner_id = '" + toRefund.id() + "'").get(0).get("status"));
            Map<String, Object> balRf = owner.sql("SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM finance.account_balance WHERE community_id = '" + cid + "'").get(0);
            assertEquals(balRf.get("d"), balRf.get("c"), "the refund is in the books");
            // the bank refuses a refund: it is due again; the payment service down: nothing is asked, nothing charged
            sim.mode(new SimulatedGateway.Mode(SimulatedGateway.Service.NORMAL, true));
            var refused = paidOnline.apply(today.plusDays(25));
            as(admin, () -> bookingSvc.initiateRefund(admin, refused.id(), refused.version(), "fee"));
            com.communityos.api.demo.ReplayClock.at(java.time.Instant.now().plusSeconds(61), () -> { simBank.run(); return null; });
            assertEquals("Refund due", as(admin, () -> bookingSvc.get(admin, refused.id())).state().refundStatus, "refused by the bank: due again");
            assertEquals("Failed", owner.sql("SELECT status FROM billing.gateway_refund WHERE community_id = '" + cid + "' AND owner_id = '" + refused.id() + "'").get(0).get("status"));
            sim.mode(new SimulatedGateway.Mode(SimulatedGateway.Service.DOWN, false));
            var again = as(admin, () -> bookingSvc.get(admin, refused.id()));
            assertTrue(assertThrows(com.communityos.api.shared.resilience.TransientFailure.class, () -> as(admin, () -> bookingSvc.initiateRefund(admin, refused.id(), again.version(), "fee")))
                .getMessage().contains("nothing was sent back"));
            assertEquals("Refund due", as(admin, () -> bookingSvc.get(admin, refused.id())).state().refundStatus);
            assertTrue(assertThrows(com.communityos.api.shared.resilience.TransientFailure.class, () -> as(ownerC, () -> pay.createOrder(ownerC,
                new PaymentService.CreateOrder(List.of(), "booking", new UnitId(unitA), Money.of("100")), "it-down-" + tag))).getMessage().contains("nothing was charged"));
            sim.mode(new SimulatedGateway.Mode(SimulatedGateway.Service.NORMAL, false));
            assertEquals("0.00", acct.apply("1100"), "nothing is owed");
            assertEquals("1500.00", owner.sql("SELECT sum(amount)::text AS s FROM billing.unit_credit WHERE community_id = '" + cid + "' AND unit_id = '" + unitA + "'").get(0).get("s"), "the deposit back as credit");

            // ---- 6f. the gate: a pass, an approval with "always allow", deliveries by the unit's rule, household staff, goods, patrols, the sweep ---------
            var gateSvc = new com.communityos.api.gate.application.GateService(new com.communityos.api.gate.adapter.JdbcGateStore(app), new com.communityos.api.gate.adapter.JdbcGateDirectory(app, json),
                events, audit, app, clock);
            var pass = as(ownerC, () -> gateSvc.createPass(ownerC, new com.communityos.api.gate.application.GateService.NewPass("Meera", null, null, "One-time", null, null, null, null, List.of(), null,
                null, null, null, null, false, null, null)));
            assertTrue(pass.code.matches("\\d{6}")); assertEquals(new UnitId(unitA), pass.unit);
            assertEquals(pass.code, as(ownerC, () -> gateSvc.pass(ownerC, pass.id)).code, "one pass by its id");
            assertThrows(AccessDenied.NotVisible.class, () -> as(plumberC, () -> gateSvc.pass(plumberC, pass.id)), "with the list's own scope");
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
                "Lakshmi", "Maid / cook", null, null, "Active", null, null, "Aadhaar", "1234", true, null, null, null, false, false, false, null, false, false, null, null, null, null))), "cleared without the ID check");
            var maid = as(admin, () -> kit.create(admin, com.communityos.api.gate.GateResources.PEOPLE, people, new com.communityos.api.gate.GateResources.PersonFields(
                "Lakshmi", "Maid / cook", null, null, "Active", null, null, "Aadhaar", "1234", true, null, null, null, true, true, true, null, true, true, null, null, null, null)));
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> kit.create(ownerC, com.communityos.api.gate.GateResources.PEOPLE, people, new com.communityos.api.gate.GateResources.PersonFields(
                "Raju", "Driver", null, null, "Active", null, null, null, null, true, null, null, null, true, false, false, null, false, false, null, null, null, null))), "a resident cannot clear anyone");
            var invited = as(ownerC, () -> kit.create(ownerC, com.communityos.api.gate.GateResources.PEOPLE, people, new com.communityos.api.gate.GateResources.PersonFields(
                "Raju", "Driver", null, null, null, null, null, null, null, true, null, null, null, false, false, false, null, false, false, null, null, null, null)));
            assertEquals("Invited", invited.data().status(), "a resident only invites"); assertFalse(invited.data().idChecked()); assertEquals(unitA, invited.data().invitedByUnitId());
            var links = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.gate.GateResources.LINKS.table(), app, json);
            as(ownerC, () -> kit.create(ownerC, com.communityos.api.gate.GateResources.LINKS, links, new com.communityos.api.gate.GateResources.LinkFields(maid.id(), "Lakshmi", unitA, List.of(), null, null, null)));
            var maidIn = as(admin, () -> gateSvc.admitPerson(admin, maid.id(), "Main gate", "Face", null));
            assertTrue(maidIn.ok(), maidIn.reason()); assertEquals(new UnitId(unitA), maidIn.visit().unit);
            assertEquals("already-inside", as(admin, () -> gateSvc.admitPerson(admin, maid.id(), "Main gate", "Face", null)).outcome());
            var blockedP = as(admin, () -> kit.create(admin, com.communityos.api.gate.GateResources.PEOPLE, people, new com.communityos.api.gate.GateResources.PersonFields(
                "Thief", "Other", null, null, "Blocked", null, null, null, null, false, null, null, null, false, false, false, null, false, false, null, "Theft in 2025", null, null)));
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
            var gateSettings = as(admin, () -> new com.communityos.api.gate.adapter.JdbcGateDirectory(app, json).settings());
            boolean quietNow = gateSettings.quiet(java.time.ZonedDateTime.now(clock.withZone(ZoneId.of("Asia/Kolkata"))));
            assertEquals(quietNow ? gateSettings.quietFallback() : "Deny", asked2.approval().fallback, "the unit's own fallback (the community's quiet-hours one at night)");
            owner.sql("UPDATE gate.approval SET expires_at = now() - interval '1 minute' WHERE id = '" + asked2.approval().id + "' RETURNING 1");
            Caller gateJob = com.communityos.api.shared.security.SystemCaller.of(new CommunityId(cid), "gate sweep");
            assertTrue(as(gateJob, () -> gateSvc.sweep(gateJob)) >= 1);
            boolean autoDeny = "Deny".equals(asked2.approval().fallback);
            assertEquals(autoDeny ? "Denied" : "No answer", owner.sql("SELECT status FROM gate.approval WHERE id = '" + asked2.approval().id + "'").get(0).get("status"));
            assertEquals(autoDeny ? "Denied" : "No answer", owner.sql("SELECT state FROM gate.visit WHERE approval_id = '" + asked2.approval().id + "'").get(0).get("state"));
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
            assertTrue(titles.stream().noneMatch((t) -> t.equals("Payment received · RCP-0001") || t.startsWith("Booked")), "nobody is told about what they did themselves: " + titles);
            assertTrue(titles.contains("Payment received · RCP-0003"), "but a payment the bank's webhook settled is news to them: " + titles);
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
            // the channel copies leave through the provider (here the development one): Sent, with the provider's reference; a failure is retried, then Failed
            var failing = new com.communityos.api.comms.adapter.ChannelDelivery(platform, new com.communityos.api.comms.application.port.ChannelSender() {
                public String name() { return "down"; }
                public Result send(String ch, String to, String subject, String body) { return Result.failed("provider down"); }
            });
            while (failing.runOnce(500) == 500) { }                 // each queued message is claimed once (then leased for two minutes)
            var tried = owner.sql("SELECT status, attempts::text AS attempts, error FROM comms.outbox_message WHERE community_id = '" + cid + "' AND membership_id = '" + members[0] + "' AND event = 'bill' AND channel = 'WhatsApp'").get(0);
            assertEquals("Queued", tried.get("status"), "one failure is tried again later"); assertEquals("1", tried.get("attempts")); assertEquals("provider down", tried.get("error"));
            owner.sql("UPDATE comms.outbox_message SET custom = custom - 'leaseUntil' WHERE community_id = '" + cid + "' RETURNING 1");      // the lease has run out
            var delivery = new com.communityos.api.comms.adapter.ChannelDelivery(platform, new com.communityos.api.comms.adapter.SimulatedChannelSender());
            while (delivery.runOnce(500) > 0) { }
            var chSent = owner.sql("SELECT status, sent_at IS NOT NULL AS at, custom ->> 'provider' AS provider, error FROM comms.outbox_message WHERE community_id = '" + cid + "' AND membership_id = '" + members[0] + "' AND event = 'bill' ORDER BY channel");
            assertEquals("Skipped", chSent.get(0).get("status"), "nothing to send to"); assertEquals("Sent", chSent.get(1).get("status")); assertEquals("simulated", chSent.get(1).get("provider"));
            assertEquals(0, delivery.runOnce(500), "sent once");
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
            // push: the owner allows notifications on a phone; a new bill is queued for it, encrypted for that phone alone (RFC 8291) and signed with the
            // server's key (VAPID); a phone the push service no longer knows is removed; the open app gets it over its live stream, once
            var phoneGen = java.security.KeyPairGenerator.getInstance("EC"); phoneGen.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));
            var phoneKeys = phoneGen.generateKeyPair(); byte[] phoneAuth = new byte[16]; new java.security.SecureRandom().nextBytes(phoneAuth);
            String p256dh = com.communityos.api.shared.push.WebPush.B64.encodeToString(com.communityos.api.shared.push.WebPush.raw((java.security.interfaces.ECPublicKey) phoneKeys.getPublic()));
            String authB64 = com.communityos.api.shared.push.WebPush.B64.encodeToString(phoneAuth);
            var vapid = com.communityos.api.shared.push.WebPush.generate();
            List<HttpTransport.Request> pushed = new ArrayList<>();
            HttpTransport pushService = (preq) -> { pushed.add(preq); return new HttpTransport.Response(preq.uri().getPath().startsWith("/gone") ? 410 : 201, Map.of(), new byte[0]); };
            var pushSender = new com.communityos.api.comms.adapter.WebPushSender(pushService, vapid, "mailto:it@test", json, clock);
            var pushSvc = new com.communityos.api.comms.application.PushService(app, pushSender);
            assertEquals(vapid.publicKeyB64(), pushSvc.key().publicKey());
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> { pushSvc.subscribe(ownerC, "http://push.example.test/x", p256dh, authB64, null); return null; }), "https only");
            assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> { pushSvc.subscribe(ownerC, "https://push.example.test/x", "short", authB64, null); return null; }));
            as(ownerC, () -> { pushSvc.subscribe(ownerC, "https://push.example.test/phone-" + tag, p256dh, authB64, "it"); pushSvc.subscribe(ownerC, "https://push.example.test/gone-" + tag, p256dh, authB64, "it"); return null; });
            as(ownerC, () -> { pushSvc.subscribe(ownerC, "https://push.example.test/phone-" + tag, p256dh, authB64, "it again"); return null; });   // the same device again: one row
            assertEquals(2L, (long) as(ownerC, () -> pushSvc.devices(ownerC)));
            assertEquals(0L, (long) as(treasurer, () -> pushSvc.devices(treasurer)), "someone else's devices are theirs");
            as(treasurer, () -> { pushSvc.unsubscribe(treasurer, "https://push.example.test/phone-" + tag); return null; });
            assertEquals(2L, (long) as(ownerC, () -> pushSvc.devices(ownerC)), "and only they can remove them");
            var live = new com.communityos.api.comms.adapter.LiveHub(platform, clock);
            List<Map<String, Object>> onScreen = new ArrayList<>();
            com.communityos.api.comms.adapter.LiveHub.Tab tab = (ev, data) -> { if (ev.equals("notification")) onScreen.add(data); return true; };
            live.connect(UUID.fromString(cid.toString()), UUID.fromString(String.valueOf(members[0])), tab);
            live.connect(UUID.randomUUID(), UUID.fromString(String.valueOf(members[0])), (ev, data) -> { if (ev.equals("notification")) throw new AssertionError("another community's tab"); return true; });
            as(treasurer, () -> dueService.raise(treasurer, new DueService.RaiseDue(new UnitId(unitA), "Water", today.withDayOfMonth(1), "Push", Money.of("75"), today.plusDays(9))));
            var queuedPush = owner.sql("SELECT q.status, q.title FROM comms.push_queue q JOIN comms.push_subscription s ON s.community_id = q.community_id AND s.id = q.subscription_id WHERE q.community_id = '" + cid + "' ORDER BY s.endpoint");
            assertEquals(2, queuedPush.size(), "one per device: " + queuedPush); assertEquals("New bill · ₹75", queuedPush.get(0).get("title"));
            var pushes = new com.communityos.api.comms.adapter.PushDelivery(platform, pushSender);
            while (pushes.runOnce(100) > 0) { }                      // every community's queue (rows left by earlier runs too)
            pushed.removeIf((pr) -> !pr.uri().getPath().endsWith("-" + tag));
            assertEquals(2, pushed.size(), "one message per device");
            assertEquals(0, pushes.runOnce(100), "sent once");
            var toPhone = pushed.stream().filter((pr) -> pr.uri().getPath().startsWith("/phone-")).findFirst().orElseThrow();
            assertEquals("aes128gcm", toPhone.headers().get("Content-Encoding")); assertTrue(toPhone.headers().get("TTL") != null);
            String authz = toPhone.headers().get("Authorization");
            assertTrue(authz.startsWith("vapid t=") && authz.endsWith(", k=" + vapid.publicKeyB64()), authz);
            String[] jwt = authz.substring("vapid t=".length(), authz.indexOf(',')).split("\\.");
            var verify = java.security.Signature.getInstance("SHA256withECDSAinP1363Format"); verify.initVerify(vapid.publicKey());
            verify.update((jwt[0] + "." + jwt[1]).getBytes(StandardCharsets.US_ASCII));
            assertTrue(verify.verify(com.communityos.api.shared.push.WebPush.D64.decode(jwt[2])), "signed with the server's key");
            assertTrue(new String(com.communityos.api.shared.push.WebPush.D64.decode(jwt[1]), StandardCharsets.UTF_8).contains("\"aud\":\"https://push.example.test\""));
            Map<?, ?> openedPush = json.readValue(decryptPush(toPhone.body(), (java.security.interfaces.ECPrivateKey) phoneKeys.getPrivate(), (java.security.interfaces.ECPublicKey) phoneKeys.getPublic(), phoneAuth), Map.class);
            assertEquals("New bill · ₹75", openedPush.get("title")); assertTrue(String.valueOf(openedPush.get("link")).startsWith("#/"), "opens the app: " + openedPush);
            var afterPush = owner.sql("SELECT s.endpoint, s.last_sent_at IS NOT NULL AS touched, (SELECT string_agg(q.status, ',') FROM comms.push_queue q WHERE q.community_id = s.community_id AND q.subscription_id = s.id) AS st FROM comms.push_subscription s WHERE s.community_id = '" + cid + "'");
            assertEquals(1, afterPush.size(), "the device the push service no longer knows is removed: " + afterPush);
            assertEquals("Sent", afterPush.get(0).get("st")); assertEquals("t", afterPush.get(0).get("touched"));
            assertTrue(live.fanOut() >= 1); assertTrue(onScreen.stream().anyMatch((n) -> "New bill · ₹75".equals(n.get("title"))), "on the open screen: " + onScreen);
            int shown = onScreen.size();
            int liveAgain = live.fanOut();
            assertEquals(0, liveAgain, "not twice"); assertEquals(shown, onScreen.size());
            live.heartbeat(); live.disconnect(UUID.fromString(String.valueOf(members[0])), tab);
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
            var notices = new com.communityos.api.comms.application.BroadcastService(store, inbox, events, audit, app, clock);
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
            var allPolls = as(treasurer, () -> notices.polls(treasurer));
            assertEquals(1, allPolls.get(poll.id).results().total()); assertEquals("Villa 101", allPolls.get(poll.id).voters().get(0).unitNo(), "every poll in one call, with its voters for the committee");
            assertNull(as(ownerC, () -> notices.polls(ownerC)).get(poll.id).voters(), "a reader gets the results only");
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
            assertTrue(as(ownerC, () -> forum.allPosts(ownerC)).stream().anyMatch((p) -> p.id.equals(reply.id)), "every post in one call");
            assertTrue(as(ownerC, () -> forum.pollResults(ownerC)).containsKey(topic.id), "every poll topic's results in one call");
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
            Caller neighbour = new Caller(new PersonId(UUID.randomUUID()), new MembershipId(UUID.randomUUID()), ownerC.community(), "Neighbour", Caller.Category.Resident,
                java.util.Set.of("owner"), java.util.Set.of(), java.util.Set.of(new UnitId(UUID.randomUUID())), java.util.Set.of(), null, java.util.Set.of());
            assertThrows(AccessDenied.class, () -> as(neighbour, () -> { fileSvc.delete(neighbour, photo.id()); return null; }), "attached: not by someone who cannot change the ticket");
            as(ownerC, () -> { fileSvc.delete(ownerC, photo.id()); return null; });   // the ticket's owner takes the photo off their own ticket
            assertTrue(as(ownerC, () -> fileSvc.list(ownerC, "maintenance.ticket", leak.id())).isEmpty());

            // ---- 6i. cultural: an event through the kit, pledges and receipts in the books, an online donation, a fixed offering, seva sign-ups, expenses -------
            var cstore = new com.communityos.api.cultural.adapter.JdbcCulturalStore(app, new com.communityos.api.approval.application.PlanCodec(json), json);
            var cdesk = new com.communityos.api.billing.application.BillingDesk(payments, new com.communityos.api.billing.application.TargetSettlement(dues, payments, events, audit, app, clock),
                new JdbcJournalWriter(app), events, clock);
            var donSvc = new com.communityos.api.cultural.application.DonationService(cstore, cdesk, events, audit, app, clock);
            var expSvc = new com.communityos.api.cultural.application.ExpenseService(cstore, new com.communityos.api.approval.adapter.JdbcApprovalSettings(app, json), cdesk, events, audit, app, clock);
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

            // ---- 6j. finance beyond bills: the cash book with taxes, a second approver above the limit, closed books, reversal, bank matching, releases ----
            var fstore = new com.communityos.api.finance.adapter.JdbcFinanceStore(app, new com.communityos.api.approval.application.PlanCodec(json));
            var cashSvc = new com.communityos.api.finance.application.CashBookService(fstore, cdesk, audit, app, clock);
            var fapprovals = new com.communityos.api.approval.adapter.JdbcApprovalSettings(app, json);
            var payReqSvc = new com.communityos.api.finance.application.PayRequestService(fstore, cashSvc, fapprovals, json, audit, app);
            var bankSvc = new com.communityos.api.finance.application.BankService(fstore, audit, app);
            var relSvc = new com.communityos.api.finance.application.ReleaseService(fstore, qrepo, fapprovals, cashSvc, events, audit, app, clock);
            java.util.function.Supplier<com.communityos.api.finance.domain.Books.Entry> plumbing = () -> {
                var e = new com.communityos.api.finance.domain.Books.Entry();
                e.date = today; e.type = "Debit"; e.description = "Pipe repairs"; e.vendor = "Aqua Pumps"; e.baseAmount = new java.math.BigDecimal("10000"); e.gstRate = new java.math.BigDecimal("18");
                e.tdsRate = new java.math.BigDecimal("2"); e.tdsSection = "194C"; e.mode = "Bank transfer"; e.module = "Maintenance";
                return e;
            };
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> cashSvc.record(ownerC, plumbing.get())));
            var pipe = as(admin, () -> cashSvc.record(admin, plumbing.get()));
            assertEquals(0, new java.math.BigDecimal("11600").compareTo(pipe.amount), "10000 + 1800 GST - 200 TDS"); assertEquals(0, new java.math.BigDecimal("200").compareTo(pipe.tdsAmount));
            assertEquals("200.00", owner.sql("SELECT coalesce(sum(l.credit), 0)::text AS c FROM finance.journal_line l JOIN finance.account a ON a.id = l.account_id WHERE l.community_id = '" + cid + "' AND a.code = '2150'").get(0).get("c"), "TDS owed");
            owner.sql("UPDATE finance.finance_setting SET approval_limit = 50000 WHERE community_id = '" + cid + "' RETURNING 1");
            java.util.function.Supplier<com.communityos.api.finance.domain.Books.Entry> big = () -> { var e = new com.communityos.api.finance.domain.Books.Entry(); e.date = today; e.type = "Debit"; e.description = "Lift AMC"; e.amount = new java.math.BigDecimal("60000"); e.vendor = "Otis"; return e; };
            assertEquals("needs-second-approver", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> cashSvc.record(admin, big.get()))).code());
            var payReq = as(admin, () -> payReqSvc.submit(admin, big.get()));
            assertEquals("Waiting", payReq.status);
            assertThrows(AccessDenied.class, () -> as(admin, () -> payReqSvc.decide(admin, payReq.id, payReq.version, true, null)), "a second person approves");
            var okReq = as(treasurer, () -> payReqSvc.decide(treasurer, payReq.id, payReq.version, true, "AMC renewal"));
            assertEquals("Approved", okReq.status); assertNotNull(okReq.entryId);
            var liftE = as(admin, () -> cashSvc.get(admin, okReq.entryId));
            assertEquals(0, new java.math.BigDecimal("60000").compareTo(liftE.amount)); assertEquals("Lift AMC", liftE.description);
            // the bank statement: imported once, matched to the entry, a matched entry is not reversed
            var stmt = List.of(new com.communityos.api.finance.domain.Books.BankLine(null, null, today, null, "NEFT OTIS ELEVATOR", null, new java.math.BigDecimal("60000"), null, new java.math.BigDecimal("140000"), "Otis", null, null, 0),
                new com.communityos.api.finance.domain.Books.BankLine(null, null, today, null, "INTEREST", null, null, new java.math.BigDecimal("812"), new java.math.BigDecimal("140812"), null, null, null, 0));
            assertEquals(2, as(admin, () -> bankSvc.importLines(admin, "HDFC Main", stmt)).added());
            assertEquals(0, as(admin, () -> bankSvc.importLines(admin, "HDFC Main", stmt)).added(), "the same statement twice adds nothing");
            var otis = as(admin, () -> bankSvc.lines(admin, new com.communityos.api.finance.application.port.FinanceStore.LineFilter("HDFC Main", null, null, true))).stream().filter((l) -> l.out()).findFirst().orElseThrow();
            assertEquals("wrong-way", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> bankSvc.match(admin, as(admin, () -> bankSvc.lines(admin,
                new com.communityos.api.finance.application.port.FinanceStore.LineFilter("HDFC Main", null, null, true))).stream().filter((l) -> !l.out()).findFirst().orElseThrow().id(), liftE.id))).code());
            as(admin, () -> bankSvc.match(admin, otis.id(), liftE.id));
            var liftM = as(admin, () -> cashSvc.get(admin, liftE.id));
            assertEquals("Matched", liftM.reconStatus);
            assertEquals("matched", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> cashSvc.reverse(admin, liftM.id, liftM.version, "duplicate"))).code());
            // reversal: once, with a reason, and the books still balance
            var rev = as(admin, () -> cashSvc.reverse(admin, pipe.id, pipe.version, "entered twice"));
            assertEquals("Credit", rev.type); assertEquals(pipe.shortId, rev.reversalOf);
            assertEquals("reversed", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> cashSvc.reverse(admin, pipe.id, as(admin, () -> cashSvc.get(admin, pipe.id)).version, "again"))).code());
            assertEquals("0.00", owner.sql("SELECT coalesce(sum(l.credit) - sum(l.debit), 0)::text AS n FROM finance.journal_line l JOIN finance.account a ON a.id = l.account_id WHERE l.community_id = '" + cid + "' AND a.code = '2150'").get(0).get("n"), "the TDS is reversed too");
            // closed books
            as(admin, () -> cashSvc.lock(admin, today.minusDays(1), null));
            var old = plumbing.get(); old.date = today.minusDays(3);
            assertEquals("books-closed", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> cashSvc.record(admin, old))).code());
            assertEquals("reason-required", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> cashSvc.lock(admin, null, null))).code(), "reopening needs a reason");
            as(admin, () -> cashSvc.lock(admin, null, "correction for the AGM"));
            // a release on the pump task: within what is open, its own approval, paid into the cash book
            var openBefore = as(admin, () -> qrepo.position(pump.id())).remaining();
            assertEquals("over-approved", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> relSvc.raise(admin, new com.communityos.api.finance.application.ReleaseService.NewRelease(pump.id(), null,
                "Against invoice", openBefore.amount().add(new java.math.BigDecimal("100")), "Aqua Pumps", null)))).code());
            var rel = as(admin, () -> relSvc.raise(admin, new com.communityos.api.finance.application.ReleaseService.NewRelease(pump.id(), null, "Against invoice", new java.math.BigDecimal("3000"), "Aqua Pumps", "first part")));
            assertEquals("Waiting approval", rel.status);
            assertEquals("not-approved", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> relSvc.pay(admin, rel.id, rel.version, null, null, null))).code());
            var relEc = as(treasurer, () -> relSvc.decide(treasurer, rel.id, rel.version, "Approved", null, false));
            var relOk = as(admin, () -> relSvc.decide(admin, rel.id, relEc.version, "Approved", null, false));
            assertEquals("Approved", relOk.status);
            var relPaid = as(admin, () -> relSvc.pay(admin, rel.id, relOk.version, "Bank transfer", "UTR1", null));
            assertEquals("Paid", relPaid.status); assertNotNull(relPaid.paidEntryId);
            assertEquals(0, openBefore.amount().subtract(new java.math.BigDecimal("3000")).compareTo(as(admin, () -> qrepo.position(pump.id())).remaining().amount()), "released money is committed on the task");
            var relEntry = as(admin, () -> cashSvc.get(admin, relPaid.paidEntryId));
            assertEquals("release", relEntry.sourceType); assertEquals(pump.shortId(), relEntry.taskRef);
            as(admin, () -> cashSvc.reverse(admin, relEntry.id, relEntry.version, "paid to the wrong account"));
            assertEquals("Approved", as(admin, () -> relSvc.get(admin, rel.id)).status, "its payment reversed: approved, not paid, again");
            assertTrue(as(admin, () -> fstore.accounts()).stream().anyMatch((x) -> x.code().equals("1300")));
            assertFalse(as(admin, () -> fstore.journal(today, today, "2150")).isEmpty());
            Map<String, Object> bal3 = owner.sql("SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM finance.account_balance WHERE community_id = '" + cid + "'").get(0);
            assertEquals(bal3.get("d"), bal3.get("c"), "double entry still balances");

            // ---- 6k. governance: a meeting published to residents, its minutes; a ballot - frozen roll, code, one vote per unit, sealed box, the count ----
            var gstore = new com.communityos.api.governance.adapter.JdbcGovernanceStore(app, json);
            var meetSvc = new com.communityos.api.governance.application.MeetingService(gstore, events, audit, app, clock);
            var ballotSvc = new com.communityos.api.governance.application.BallotService(gstore, events, audit, app, clock);
            List<String> voteCodes = new ArrayList<>();
            var voteSvc = new com.communityos.api.governance.application.VoteService(gstore, new CodeHasher("integration-test-pepper-0123456789"), (to, code) -> voteCodes.add(code), false, "+91",
                audit, app, clock);
            java.util.function.BiFunction<String, String, com.communityos.api.governance.application.MeetingService.Fields> agm = (vis, minutes) -> new com.communityos.api.governance.application.MeetingService.Fields(
                "Annual general meeting", "General body / AGM", today, java.time.LocalTime.of(10, 0), java.time.LocalTime.of(12, 0), "Clubhouse", minutes == null ? "Scheduled" : "Completed", vis,
                "<p>1. Accounts</p>", minutes, null);
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> meetSvc.create(ownerC, agm.apply("Internal (committee only)", null))));
            var mtg = as(admin, () -> meetSvc.create(admin, agm.apply("Internal (committee only)", null)));
            assertTrue(mtg.shortId.startsWith("MTG"));
            assertTrue(as(ownerC, () -> meetSvc.list(ownerC, null, null, null)).stream().noneMatch((m) -> m.id.equals(mtg.id)), "internal: residents do not see it");
            var mtgPub = as(admin, () -> meetSvc.update(admin, mtg.id, mtg.version, agm.apply("Published to residents", null)));
            assertNotNull(mtgPub.publishedAt);
            assertEquals(mtg.id, as(ownerC, () -> meetSvc.get(ownerC, mtg.id)).id);
            assertTrue(as(ownerC, () -> inboxSvc.mine(ownerC, false, 200)).stream().anyMatch((n) -> n.event().equals("meeting") && n.title().contains("Annual general meeting")), "residents are told");
            var mtgDone = as(admin, () -> meetSvc.update(admin, mtg.id, mtgPub.version, agm.apply("Published to residents", "<p>Accounts adopted.</p>")));
            assertEquals("Completed", mtgDone.status); assertNotNull(mtgDone.minutesAt);
            assertEquals("keep-meeting", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> { meetSvc.delete(admin, mtg.id, mtgDone.version); return null; })).code());
            assertThrows(RuntimeException.class, () -> owner.sql("UPDATE governance.meeting SET minutes = 'x', status = 'Cancelled' WHERE id = '" + mtg.id + "' RETURNING 1"), "a cancelled meeting has no minutes (the database)");
            // the ballot
            var bf = new com.communityos.api.governance.application.BallotService.Fields("Adopt the accounts for 2025-26", "<p>As presented at the AGM.</p>", "Resolution", null, today, today,
                new java.math.BigDecimal("50"), new java.math.BigDecimal("50"), mtg.id);
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> ballotSvc.create(ownerC, bf)));
            var gbal = as(admin, () -> ballotSvc.create(admin, bf));
            assertEquals(List.of("For", "Against", "Abstain"), gbal.options);
            assertThrows(AccessDenied.NotVisible.class, () -> as(ownerC, () -> ballotSvc.get(ownerC, gbal.id)), "a draft is the committee's");
            var balOpen = as(admin, () -> ballotSvc.open(admin, gbal.id, gbal.version)).ballot();
            assertEquals("Open", balOpen.status); assertEquals(1, balOpen.rollSize, "Villa 101 has a registered owner; Villa 202 only a tenant");
            assertEquals(64, balOpen.rollHash.length());
            assertThrows(RuntimeException.class, () -> owner.sql("UPDATE governance.ballot SET title = 'Something else' WHERE id = '" + gbal.id + "' RETURNING 1"), "an open ballot cannot be edited, by anyone");
            assertThrows(RuntimeException.class, () -> owner.sql("DELETE FROM governance.ballot_elector WHERE ballot_id = '" + gbal.id + "' RETURNING 1"), "the frozen roll stays");
            assertTrue(as(ownerC, () -> inboxSvc.mine(ownerC, false, 200)).stream().anyMatch((n) -> n.event().equals("ballot")), "owners are told voting is open");
            var mineView = as(ownerC, () -> ballotSvc.get(ownerC, gbal.id));
            assertEquals("", mineView.whyNotMe()); assertEquals("Villa 101", mineView.mine().get(0).unitNo());
            assertTrue(as(treasurer, () -> ballotSvc.get(treasurer, gbal.id)).whyNotMe().startsWith("Only registered owners"));
            assertThrows(AccessDenied.class, () -> as(treasurer, () -> voteSvc.requestCode(treasurer, gbal.id, unitA)), "not an owner of the unit");
            var sentCode = as(ownerC, () -> voteSvc.requestCode(ownerC, gbal.id, null));
            assertEquals(ownerPhone.substring(ownerPhone.length() - 4), sentCode.phoneLast4()); assertNull(sentCode.code()); assertEquals(1, voteCodes.size());
            assertEquals("wrong-code", assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> voteSvc.verifyCode(ownerC, gbal.id, null, voteCodes.get(0).equals("000000") ? "111111" : "000000"))).code());
            assertEquals("1", owner.sql("SELECT attempts::text AS n FROM governance.vote_challenge WHERE ballot_id = '" + gbal.id + "'").get(0).get("n"), "the wrong try is recorded although it was refused");
            String voteProof = as(ownerC, () -> voteSvc.verifyCode(ownerC, gbal.id, null, voteCodes.get(0)));
            var receipt = as(ownerC, () -> voteSvc.cast(ownerC, gbal.id, null, voteProof, "For"));
            assertEquals(1, receipt.seq());
            assertEquals("voted", assertThrows(DomainException.RuleViolated.class, () -> as(ownerC, () -> voteSvc.requestCode(ownerC, gbal.id, null))).code(), "one vote per unit");
            assertEquals("0", owner.sql("SELECT count(*)::text AS n FROM governance.vote_challenge WHERE ballot_id = '" + gbal.id + "'").get(0).get("n"), "the proof is spent");
            assertTrue(as(admin, () -> gstore.box(gbal.id)).isEmpty(), "sealed: the API role reads nothing of the box while voting is open");
            assertEquals("sealed", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> ballotSvc.box(admin, gbal.id))).code());
            assertThrows(RuntimeException.class, () -> owner.sql("UPDATE governance.ballot_box SET choice = 'Against' WHERE ballot_id = '" + gbal.id + "' RETURNING 1"), "a vote is never changed");
            assertThrows(RuntimeException.class, () -> owner.sql("DELETE FROM governance.vote_roll WHERE ballot_id = '" + gbal.id + "' RETURNING 1"), "nor its mark");
            assertEquals("0", owner.sql("SELECT count(*)::text AS n FROM governance.ballot_box x WHERE x.ballot_id = '" + gbal.id + "' AND x::text LIKE '%" + members[0] + "%'").get(0).get("n"), "nothing in the box points at the voter");
            var roll = as(ownerC, () -> ballotSvc.roll(ownerC, gbal.id));
            assertTrue(roll.get(0).voted()); assertEquals(today, roll.get(0).markedOn());
            var closedView = as(admin, () -> ballotSvc.close(admin, gbal.id, as(admin, () -> ballotSvc.get(admin, gbal.id)).ballot().version));   // everyone on the roll voted: it may close today
            assertEquals("Closed", closedView.ballot().status); assertEquals("Passed", closedView.tally().outcome()); assertTrue(closedView.chain().ok());
            var theBox = as(ownerC, () -> ballotSvc.box(ownerC, gbal.id));
            assertTrue(theBox.matchesClose()); assertEquals(receipt.receipt(), theBox.rows().get(0).receipt()); assertEquals("For", theBox.rows().get(0).choice());
            assertThrows(RuntimeException.class, () -> owner.sql("UPDATE governance.ballot SET description = 'x' WHERE id = '" + gbal.id + "' RETURNING 1"), "a closed ballot never changes");
            assertTrue(as(ownerC, () -> inboxSvc.mine(ownerC, false, 200)).stream().anyMatch((n) -> n.event().equals("ballot_result") && n.title().startsWith("Voting closed")));
            assertTrue(owner.sql("SELECT summary FROM audit.audit_event WHERE community_id = '" + cid + "' AND entity = 'governance.vote_roll'").stream().noneMatch((ar) -> String.valueOf(ar.get("summary")).contains("For")),
                "the audit trail says who voted, never what");

            // ---- 6l. vendors: the register through the kit (a discussion that stays), the directory with one review per household ------------------------
            var vRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.vendor.VendorResources.VENDORS.table(), app, json);
            var vlRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.vendor.VendorResources.SERVICE_LINES.table(), app, json);
            var vcRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.vendor.VendorResources.COMMENTS.table(), app, json);
            var aqua = as(admin, () -> kit.create(admin, com.communityos.api.vendor.VendorResources.VENDORS, vRepo,
                new com.communityos.api.vendor.VendorResources.VendorFields("Aqua Pumps", "Maintenance", "29abcde1234f1zw", "AMC", "Pumps", "+919845000000", null, null, today.plusYears(1), null)));
            assertEquals("29ABCDE1234F1ZW", aqua.data().gstin());
            assertThrows(RuntimeException.class, () -> as(admin, () -> kit.create(admin, com.communityos.api.vendor.VendorResources.VENDORS, vRepo,
                new com.communityos.api.vendor.VendorResources.VendorFields("aqua pumps", null, null, null, null, null, null, null, null, null))), "one vendor per name");
            assertTrue(as(ownerC, () -> kit.list(ownerC, com.communityos.api.vendor.VendorResources.VENDORS, vRepo)).isEmpty(), "residents do not see the register");
            as(admin, () -> kit.create(admin, com.communityos.api.vendor.VendorResources.SERVICE_LINES, vlRepo, new com.communityos.api.vendor.VendorResources.ServiceLineFields(aqua.id(), "Plumbing", 3, "Day", null, 2)));
            var aquaNow = as(admin, () -> kit.get(admin, com.communityos.api.vendor.VendorResources.VENDORS, vRepo, aqua.id()));
            assertEquals(5, ((Number) aquaNow.server("signedWorkers")).intValue(), "employees and contractors");
            var vc = as(admin, () -> kit.create(admin, com.communityos.api.vendor.VendorResources.COMMENTS, vcRepo, new com.communityos.api.vendor.VendorResources.CommentFields(aqua.id(), "Slow to respond in October")));
            assertEquals(members[2].toString(), String.valueOf(vc.server("authorId")));
            assertThrows(RuntimeException.class, () -> as(admin, () -> kit.replace(admin, com.communityos.api.vendor.VendorResources.COMMENTS, vcRepo, vc.id(), vc.version(),
                new com.communityos.api.vendor.VendorResources.CommentFields(aqua.id(), "edited"))), "a comment stays as written");
            var dir = new com.communityos.api.vendor.application.DirectoryService(new com.communityos.api.vendor.adapter.JdbcDirectoryStore(app), audit, app);
            var raju = as(ownerC, () -> dir.add(ownerC, new com.communityos.api.vendor.application.DirectoryService.ContactFields("Raju electrician", "Electrician", "+91 98450 12345", "Whitefield", "500 a visit", null, null, null, null)));
            assertEquals("Villa 101", raju.addedByUnit); assertEquals(members[0], raju.addedById);
            as(ownerC, () -> dir.review(ownerC, raju.id, new com.communityos.api.vendor.application.DirectoryService.ReviewFields(5, "Quick", "Yes")));
            as(treasurer, () -> dir.review(treasurer, raju.id, new com.communityos.api.vendor.application.DirectoryService.ReviewFields(4, null, "No")));
            as(ownerC, () -> dir.review(ownerC, raju.id, new com.communityos.api.vendor.application.DirectoryService.ReviewFields(3, "Late this time", "Yes")));
            var rajuNow = as(treasurer, () -> dir.get(treasurer, raju.id));
            assertEquals(0, new java.math.BigDecimal("3.5").compareTo(rajuNow.rating)); assertEquals(2, rajuNow.reviews); assertEquals(1, rajuNow.recommends); assertNotNull(rajuNow.myReviewId);
            assertThrows(RuntimeException.class, () -> owner.sql("INSERT INTO vendor.contact_review (community_id, contact_id, rating, author_id, unit_id) VALUES ('" + cid + "', '" + raju.id + "', 2, '" + members[1] + "', '" + unitA + "') RETURNING 1"),
                "the database keeps one review per household too");
            assertThrows(RuntimeException.class, () -> owner.sql("UPDATE vendor.contact_review SET rating = 9 WHERE contact_id = '" + raju.id + "' RETURNING 1"));
            var rajuHidden = as(admin, () -> dir.change(admin, raju.id, rajuNow.version, new com.communityos.api.vendor.application.DirectoryService.ContactFields("Raju electrician", "Electrician",
                "+91 98450 12345", "Whitefield", "500 a visit", null, null, "Hidden", "Complaints about safety")));
            assertEquals("Hidden", rajuHidden.status);
            assertTrue(as(plumberC, () -> dir.list(plumberC)).stream().noneMatch((x) -> x.id.equals(raju.id)), "hidden from others");

            // ---- 6m. assets: equipment and its condition log, stock that moves only by movements, readings worked out, one row a day / month -------------
            var eqRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.assets.AssetResources.EQUIPMENT.table(), app, json);
            var invRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.assets.AssetResources.INVENTORY.table(), app, json);
            var plRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.assets.AssetResources.PLANT_LOGS.table(), app, json);
            var ueRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.assets.AssetResources.UNIT_ELECTRICITY.table(), app, json);
            var assetSvc = new com.communityos.api.assets.application.AssetService(new com.communityos.api.assets.adapter.JdbcAssetStore(app), events, audit, app, clock);
            var stpPump = as(admin, () -> kit.create(admin, com.communityos.api.assets.AssetResources.EQUIPMENT, eqRepo, new com.communityos.api.assets.AssetResources.EquipmentFields("STP pump A", "STP", "Pump",
                "Plumbing", List.of("Electrical"), "STP room", 2, Map.of("Power (kW)", "7.5"), null, null, "Kirloskar", "KDS", null, null, null, null, null, null, null, null, null, "Working", 0,
                List.of(), null, null, null, null, null, null, null)));
            assertEquals("7.5", ((Map<?, ?>) stpPump.data().specs()).get("Power (kW)"));
            assertTrue(as(ownerC, () -> kit.list(ownerC, com.communityos.api.assets.AssetResources.EQUIPMENT, eqRepo)).isEmpty(), "residents do not see the register");
            var cond = as(admin, () -> assetSvc.condition(admin, stpPump.id(), today, "Needs attention", "Inspection", "Noisy bearing", leak.id()));
            assertEquals("STP pump A", cond.assetName()); assertEquals(members[2], cond.byId());
            assertEquals("Needs attention", as(admin, () -> kit.get(admin, com.communityos.api.assets.AssetResources.EQUIPMENT, eqRepo, stpPump.id())).data().status(), "the condition follows its log");
            assertThrows(RuntimeException.class, () -> owner.sql("UPDATE assets.condition_log SET condition = 'Working' WHERE asset_id = '" + stpPump.id() + "' RETURNING 1"), "the log is kept as written");
            var saltItem = as(admin, () -> kit.create(admin, com.communityos.api.assets.AssetResources.INVENTORY, invRepo, new com.communityos.api.assets.AssetResources.InventoryFields("Softener salt", "Chemicals", "STP store", "Kg",
                new java.math.BigDecimal("20"), null, null, null, null, null)));
            assertEquals("Out of stock", saltItem.server("stockStatus"));
            as(admin, () -> assetSvc.move(admin, saltItem.id(), "Received", new java.math.BigDecimal("50"), null, null, "Tata Chemicals", null));
            assertEquals("not-enough", assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> assetSvc.move(admin, saltItem.id(), "Issued", new java.math.BigDecimal("80"), null, null, null, null))).code());
            var issued = as(admin, () -> assetSvc.move(admin, saltItem.id(), "Issued", new java.math.BigDecimal("32.5"), null, leak.id(), null, "softener"));
            assertEquals(0, new java.math.BigDecimal("17.5").compareTo(issued.item().quantity()));
            var saltNow = as(admin, () -> kit.get(admin, com.communityos.api.assets.AssetResources.INVENTORY, invRepo, saltItem.id()));
            assertEquals("Low", saltNow.server("stockStatus")); assertEquals(today.toString(), String.valueOf(saltNow.server("lastRestocked")));
            assertEquals(2, as(admin, () -> assetSvc.movements(admin, saltItem.id())).size());
            assertThrows(RuntimeException.class, () -> owner.sql("DELETE FROM assets.inventory_movement WHERE item_id = '" + saltItem.id() + "' RETURNING 1"), "movements are kept");
            assertThrows(RuntimeException.class, () -> owner.sql("UPDATE assets.inventory_item SET quantity = -1 WHERE id = '" + saltItem.id() + "' RETURNING 1"));
            var pl = as(admin, () -> kit.create(admin, com.communityos.api.assets.AssetResources.PLANT_LOGS, plRepo, new com.communityos.api.assets.AssetResources.PlantLogFields(today, new java.math.BigDecimal("1000"),
                new java.math.BigDecimal("1062"), null, null, null, null, null, null, null, null, null, null, null, null)));
            assertEquals(0, new java.math.BigDecimal("62").compareTo(pl.data().bhKl()));
            assertThrows(RuntimeException.class, () -> as(admin, () -> kit.create(admin, com.communityos.api.assets.AssetResources.PLANT_LOGS, plRepo, new com.communityos.api.assets.AssetResources.PlantLogFields(today,
                null, null, null, null, null, null, null, null, null, null, null, null, null, null))), "one plant log a day");
            var ue = as(admin, () -> kit.create(admin, com.communityos.api.assets.AssetResources.UNIT_ELECTRICITY, ueRepo, new com.communityos.api.assets.AssetResources.UnitElectricityFields(unitA, "2026-09",
                new java.math.BigDecimal("412"), null, null, new java.math.BigDecimal("3296"), null, new java.math.BigDecimal("6.2"), new java.math.BigDecimal("5"), null)));
            assertEquals("Villa 101", ue.server("unit"));
            assertThrows(RuntimeException.class, () -> as(admin, () -> kit.create(admin, com.communityos.api.assets.AssetResources.UNIT_ELECTRICITY, ueRepo, new com.communityos.api.assets.AssetResources.UnitElectricityFields(unitA,
                "2026-09", null, null, null, null, null, null, null, null))), "one row per unit and month");

            // ---- 6n. workforce: the site's setting through the kit, clock in and out at the server's time, one open session, a correction, planned shifts ----
            var attSvc = new com.communityos.api.workforce.application.AttendanceService(new com.communityos.api.workforce.adapter.JdbcAttendanceStore(app, json), audit, app, clock);
            var wsRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.workforce.WorkforceResources.SETTINGS.table(), app, json);
            var shRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.workforce.WorkforceResources.SHIFTS.table(), app, json);
            var site = as(admin, () -> kit.list(admin, com.communityos.api.workforce.WorkforceResources.SETTINGS, wsRepo)).get(0);
            assertEquals("Record only (flag exceptions)", site.data().enforcement(), "every community starts with one");
            var siteNow = as(admin, () -> kit.replace(admin, com.communityos.api.workforce.WorkforceResources.SETTINGS, wsRepo, site.id(), site.version(),
                new com.communityos.api.workforce.WorkforceResources.SettingFields("Main gate", new java.math.BigDecimal("12.9716"), new java.math.BigDecimal("77.5946"), 300, "Require location inside the site", 15,
                    Map.of("Morning", "06:00", "General", "09:00"), new java.math.BigDecimal("12"))));
            assertEquals("Require location inside the site", siteNow.data().enforcement());
            assertThrows(RuntimeException.class, () -> as(admin, () -> kit.create(admin, com.communityos.api.workforce.WorkforceResources.SETTINGS, wsRepo, siteNow.data())), "one setting per community");
            as(admin, () -> kit.create(admin, com.communityos.api.workforce.WorkforceResources.SHIFTS, shRepo, new com.communityos.api.workforce.WorkforceResources.ShiftFields(fs.id(), today, "General", null)));
            assertThrows(RuntimeException.class, () -> as(admin, () -> kit.create(admin, com.communityos.api.workforce.WorkforceResources.SHIFTS, shRepo,
                new com.communityos.api.workforce.WorkforceResources.ShiftFields(fs.id(), today, "Morning", null))), "one planned shift a day");
            assertEquals("outside-site", assertThrows(DomainException.RuleViolated.class, () -> as(plumberC, () -> attSvc.clockIn(plumberC,
                new com.communityos.api.workforce.application.AttendanceService.Position(new java.math.BigDecimal("13.2"), new java.math.BigDecimal("77.5946"), null), null, null))).code());
            var punch = as(plumberC, () -> attSvc.clockIn(plumberC, new com.communityos.api.workforce.application.AttendanceService.Position(new java.math.BigDecimal("12.9718"), new java.math.BigDecimal("77.5947"),
                new java.math.BigDecimal("8")), null, "at the gate"));
            assertEquals("General", punch.shiftType, "the planned shift"); assertEquals("Inside site", punch.in.site());
            assertEquals("t", owner.sql("SELECT clocked_in::text AS c FROM maintenance.field_staff WHERE membership_id = '" + plumberMember + "'").get(0).get("c").toString().substring(0, 1), "on duty");
            assertThrows(RuntimeException.class, () -> owner.sql("INSERT INTO workforce.attendance_session (community_id, member_id, date, clock_in) VALUES ('" + cid + "', '" + plumberMember + "', current_date, now()) RETURNING 1"),
                "one open session a member (the database)");
            var punched = as(plumberC, () -> attSvc.clockOut(plumberC, null, null));
            assertNotNull(punched.hours);
            assertEquals("f", owner.sql("SELECT clocked_in::text AS c FROM maintenance.field_staff WHERE membership_id = '" + plumberMember + "'").get(0).get("c").toString().substring(0, 1), "off duty");
            var corrected = as(admin, () -> attSvc.correct(admin, punched.id, punched.version, new com.communityos.api.workforce.application.AttendanceService.Correction(
                punched.clockIn.minusSeconds(1800), punched.clockOut, "Gate tablet was down")));
            assertEquals("Supervisor", corrected.source); assertTrue(corrected.hours.compareTo(new java.math.BigDecimal("0.49")) > 0);
            assertEquals(1, as(plumberC, () -> attSvc.list(plumberC, today.minusDays(1), today, null)).size());
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> attSvc.list(ownerC, null, null, null)));
            assertTrue(as(admin, () -> attSvc.teams(admin)).stream().anyMatch((t) -> t.total() >= 1));

            // ---- 6o. reports: built on the server from the community's data, a resident's own unit only, a schedule sent to a unit and kept --------------
            var repSvc = new com.communityos.api.reports.application.ReportService(new com.communityos.api.reports.adapter.JdbcReportData(app), inbox, json, audit, app, clock);
            for (String type : List.of("bookings", "dues", "collections", "water", "tasks", "audits", "infra", "eventwork"))
                assertNotNull(as(admin, () -> repSvc.build(admin, type, null, null)).report().title(), type);
            var duesAll = as(admin, () -> repSvc.build(admin, "dues", null, null)).report();
            var duesMine = as(ownerC, () -> repSvc.build(ownerC, "dues", null, null)).report();
            assertEquals("Your dues · Villa 101", duesMine.title());
            assertTrue(duesMine.rows().stream().allMatch((row) -> "Villa 101".equals(row.get(0))), "only their own unit");
            assertTrue(duesAll.rows().size() >= duesMine.rows().size());
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> repSvc.build(ownerC, "collections", null, null)));
            assertEquals(1, as(admin, () -> repSvc.build(admin, "infra", null, null)).report().rows().size(), "the pump that needs attention");
            var rsRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.reports.ReportResources.SCHEDULES.table(), app, json);
            var rrRepo = new com.communityos.api.shared.resource.JdbcResourceRepository<>(com.communityos.api.reports.ReportResources.RUNS.table(), app, json);
            var sched = as(admin, () -> kit.create(admin, com.communityos.api.reports.ReportResources.SCHEDULES, rsRepo, new com.communityos.api.reports.ReportResources.ScheduleFields("Dues to Villa 101", "dues",
                null, "Detailed", "Daily", java.time.LocalTime.MIDNIGHT, null, null, List.of("In-app"), "Selected villas", List.of(), List.of(unitA), List.of(), null, null, List.of(), null, null, null,
                null, null, false, true)));
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> kit.create(admin, com.communityos.api.reports.ReportResources.SCHEDULES, rsRepo, new com.communityos.api.reports.ReportResources.ScheduleFields(
                "x", "dues", null, null, null, null, null, null, null, "Selected villas", List.of(), List.of(), List.of(), null, null, null, null, null, null, null, null, null, null))), "to which units?");
            var manual = as(admin, () -> repSvc.run(admin, sched.id(), true));
            assertEquals("1 unit (each sees only its own)", manual.sentTo());
            assertTrue(as(ownerC, () -> inboxSvc.mine(ownerC, false, 200)).stream().anyMatch((n) -> n.event().equals("report") && n.title().equals("Your dues · Villa 101")), "the unit hears of its own dues");
            var system = com.communityos.api.shared.security.SystemCaller.of(new CommunityId(cid), "scheduled reports");
            assertEquals(1, (int) as(system, () -> repSvc.runDue(system)));
            assertEquals(0, (int) as(system, () -> repSvc.runDue(system)), "once a day");
            assertEquals(today.toString(), String.valueOf(as(admin, () -> kit.get(admin, com.communityos.api.reports.ReportResources.SCHEDULES, rsRepo, sched.id())).server("lastRunKey")));
            var runs = as(admin, () -> kit.list(admin, com.communityos.api.reports.ReportResources.RUNS, rrRepo));
            assertEquals(2, runs.size()); assertTrue(runs.stream().anyMatch((x) -> Boolean.TRUE.equals(x.server("manual"))));
            assertTrue(as(ownerC, () -> kit.list(ownerC, com.communityos.api.reports.ReportResources.RUNS, rrRepo)).isEmpty(), "sent reports are the reporters'");
            assertThrows(RuntimeException.class, () -> owner.sql("UPDATE reports.run SET title = 'edited' WHERE community_id = '" + cid + "' RETURNING 1"), "kept as it was sent");

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
            // ---- 9. the La Paloma demo: loaded through the services into a fresh community, once ---------------------------------------------------------
            UUID demoC = UUID.fromString((String) owner.sql("INSERT INTO platform.community (slug, name) VALUES ('demo-" + tag + "', 'La Paloma " + tag + "') RETURNING id").get(0).get("id"));
            owner.sql("SELECT platform.provision_community('" + demoC + "')");
            owner.sql("SELECT set_config('app.community_id', '" + demoC + "', false)");
            owner.sql("INSERT INTO property.unit (community_id, unit_no, unit_type) SELECT '" + demoC + "', 'Villa ' || g, 'Villa' FROM generate_series(1, 212) g RETURNING 1");
            UUID demoAdminP = id(owner, "INSERT INTO identity.person (phone_e164, full_name) VALUES ('+9193" + String.format("%08d", Long.parseLong(tag) % 100_000_000L) + "', 'Demo Admin') RETURNING id");
            UUID demoAdminM = id(owner, "INSERT INTO identity.membership (community_id, person_id, display_name) VALUES ('" + demoC + "', '" + demoAdminP + "', 'Super Admin') RETURNING id");
            owner.sql("INSERT INTO identity.membership_role (community_id, membership_id, role_id, is_primary) SELECT '" + demoC + "', '" + demoAdminM + "', id, true FROM identity.role WHERE community_id = '" + demoC + "' AND code = 'super_admin' RETURNING 1");
            Caller demoAdmin = callers.load(new PersonId(demoAdminP), new CommunityId(demoC), new MembershipId(demoAdminM)).orElseThrow();
            var demoRegistry = new com.communityos.api.shared.resource.ResourceRegistry(app, json);
            for (var rr : com.communityos.api.config.ResourcesConfig.all()) demoRegistry.add(rr);
            var demoServices = new com.communityos.api.demo.DemoData.Services(app, json, callers, memberService, staffSvc, units, dueService, counter, pay, java.util.Optional.of(sim), ticketSvc,
                docsSvc, kit, demoRegistry, bookingSvc, gateSvc, notices, forum, fileSvc, docSvc, donSvc, expSvc, cashSvc, bankSvc, meetSvc, ballotSvc, dir, assetSvc, attSvc, clock, ZoneId.of("Asia/Kolkata"));
            var sample = json.readTree(new java.io.File("src/main/resources/demo/la-paloma.json"));
            var setup = new com.communityos.api.demo.PlatformSetup(platform);
            var demo = new com.communityos.api.demo.DemoData(demoServices).load(new CommunityId(demoC), demoAdmin, sample, setup);
            System.out.println("demo: " + demo.message() + "\n  rows " + demo.rows() + "\n  skipped " + demo.skipped());
            demo.problems().forEach((x) -> System.out.println("  refused " + x));
            assertTrue(demo.loaded(), demo.message());
            assertEquals(List.of(), demo.problems(), "every sample record the v2 server keeps is loaded");
            Map<String, Object> demoBooks = owner.sql("SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM finance.account_balance WHERE community_id = '" + demoC + "'").get(0);
            assertEquals(demoBooks.get("d"), demoBooks.get("c"), "the demo's books balance");
            for (String t : List.of("identity.membership:21", "property.unit:216", "billing.due:13", "maintenance.ticket:8", "maintenance.quotation:7", "amenity.booking:8", "gate.pass:4",
                    "comms.broadcast:1", "comms.forum_topic:3", "docs.document:4", "cultural.donation:10", "cultural.expense:5", "finance.bank_txn:3835", "governance.meeting:2",
                    "vendor.service_contact:4", "vendor.contact_review:4", "assets.equipment:97", "assets.inventory_item:59", "assets.plant_log:60", "workforce.attendance_session:20",
                    "reports.schedule:4", "cultural.event:27")) {
                String[] x = t.split(":");
                assertEquals(x[1], owner.sql("SELECT count(*)::text AS n FROM " + x[0] + " WHERE community_id = '" + demoC + "'").get(0).get("n"), x[0]);
            }
            assertFalse(new com.communityos.api.demo.DemoData(demoServices).load(new CommunityId(demoC), demoAdmin, sample, setup).loaded(), "once per community");
            // the demo sign-in: tokens for a member of the roster without a code (dev only), as from a real sign-in
            Map<String, Object> arjun = owner.sql("SELECT m.id, m.person_id FROM identity.membership m WHERE m.community_id = '" + demoC + "' AND m.display_name = 'Ananya Mehta'").get(0);
            var demoTokens = auth.demoSignIn(new PersonId(UUID.fromString((String) arjun.get("person_id"))), new CommunityId(demoC), new MembershipId(UUID.fromString((String) arjun.get("id"))),
                new AuthService.Client("it", "10.1.2.3"));
            Map<String, Object> demoClaims = codec.verify(demoTokens.accessToken());
            assertEquals(arjun.get("id"), demoClaims.get("mid"));
            assertThrows(com.communityos.api.shared.security.Unauthenticated.class, () -> auth.demoSignIn(new PersonId(UUID.fromString((String) arjun.get("person_id"))), new CommunityId(cid),
                new MembershipId(UUID.fromString((String) arjun.get("id"))), new AuthService.Client("it", "10.1.2.3")), "only a membership the person has");

            // ---- 10. the counts above a page: worked out from the same rows with the same rules, so they always match the list under them ----------
            var summaries = new com.communityos.api.summary.SummaryService(app, clock);
            for (Caller who : List.of(admin, ownerC, treasurer)) {
                var ts = as(who, () -> summaries.tickets(who));
                var list = as(who, () -> ticketSvc.list(who, new com.communityos.api.maintenance.application.port.TicketRepository.Filter(null, false, null, null, null, null, null), PageQuery.of(200, 0)));
                assertEquals(list.total(), ts.total(), who.displayName() + ": the ticket count is the list's");
                assertEquals(list.items().stream().filter((t) -> List.of("Open", "Assigned", "In Progress", "On Hold").contains(t.status().label())).count(), ts.active());
                // the Maintenance page's own filters and orders, on the server: the same rows as filtering the whole list
                var liveSt = List.of("Open", "Assigned", "In Progress", "On Hold");
                var hot = as(who, () -> ticketSvc.list(who, new com.communityos.api.maintenance.application.port.TicketRepository.Filter(null, false, null, null, null, null, null,
                    liveSt, List.of("High", "Critical"), null, null, null, "sla"), PageQuery.of(200, 0)));
                assertEquals(list.items().stream().filter((t) -> liveSt.contains(t.status().label()) && List.of("High", "Critical").contains(t.state().priority)).count(), hot.total(), "critical card");
                for (int k = 1; k < hot.items().size(); k++) {
                    var a = hot.items().get(k - 1).state().slaDueAt; var b = hot.items().get(k).state().slaDueAt;
                    assertTrue(a == null || (b != null && !b.isBefore(a)), "SLA soonest first, none first");
                }
                var finOnly = as(who, () -> ticketSvc.list(who, new com.communityos.api.maintenance.application.port.TicketRepository.Filter(null, false, null, null, null, null, null,
                    null, null, null, true, null, "status"), PageQuery.of(200, 0)));
                assertEquals(list.items().stream().filter((t) -> t.state().financial).count(), finOnly.total(), "financial only");
                var oneType = list.items().isEmpty() || list.items().get(0).state().taskType == null ? null : list.items().get(0).state().taskType.name();
                if (oneType != null) assertEquals(list.items().stream().filter((t) -> t.state().taskType != null && oneType.equals(t.state().taskType.name())).count(),
                    as(who, () -> ticketSvc.list(who, new com.communityos.api.maintenance.application.port.TicketRepository.Filter(null, false, null, null, null, null, null,
                        null, null, oneType, null, null, null), PageQuery.of(200, 0))).total(), "by task type");
                var ds = as(who, () -> summaries.dues(who));
                if (ds != null) {
                    var bills = as(who, () -> dueService.list(who, new DueRepository.Filter(null, null, null, null, null, true), PageQuery.of(200, 0)));
                    assertEquals(bills.total(), ds.open(), who.displayName() + ": open bills");
                    assertEquals(bills.items().stream().map((d) -> d.outstanding().amount()).reduce(java.math.BigDecimal.ZERO, java.math.BigDecimal::add).setScale(2), ds.outstanding(), "outstanding is the bills' own");
                }
                var gNow = as(who, () -> summaries.gate(who));
                assertEquals(as(who, () -> gateSvc.visits(who, new com.communityos.api.gate.application.port.GateStore.VisitFilter("Inside", null, null, null, false))).size(), gNow.inside(), "inside now");
            }
            var dash = as(demoAdmin, () -> summaries.dashboard(demoAdmin));
            assertEquals(8, dash.tickets().total(), "the demo's tickets"); assertNotNull(dash.dues()); assertNotNull(dash.staff());
            assertEquals(216, dash.homes().total(), "the demo's units");
            assertEquals(owner.sql("SELECT count(*)::text AS n FROM gate.visit WHERE community_id = '" + demoC + "' AND state = 'Inside' AND kind = 'Crew'").get(0).get("n"), String.valueOf(dash.gate().insideCrew()));
            assertNull(as(ownerC, () -> summaries.staff(ownerC)), "a resident does not see who is on duty");

            // ---- 11. each community's own time zone: "today" is the community's, not the server's -------------------------------------------------------------
            owner.sql("UPDATE platform.community SET time_zone = 'America/New_York' WHERE id = '" + other + "' RETURNING 1");
            Instant at = Instant.parse("2026-10-21T02:00:00Z");                         // 07:30 on the 21st in India, 22:00 on the 20th in New York
            var cclock = new com.communityos.api.shared.time.CommunityClock(Clock.fixed(at, ZoneId.of("Asia/Kolkata")), (cId) -> platform.query(
                "SELECT time_zone FROM platform.community WHERE id = CAST(:id AS uuid)", Map.of("id", cId.toString()), (rs, i) -> rs.getString("time_zone")).stream().findFirst());
            Caller nyJob = com.communityos.api.shared.security.SystemCaller.of(new CommunityId(other), "it");
            assertEquals(ZoneId.of("America/New_York"), as(nyJob, cclock::getZone));
            assertEquals(LocalDate.of(2026, 10, 20), as(nyJob, () -> LocalDate.now(cclock)), "the New York community's today");
            assertEquals(LocalDate.of(2026, 10, 21), as(admin, () -> LocalDate.now(cclock)), "this community's (India)");
            assertEquals(LocalDate.of(2026, 10, 21), LocalDate.now(cclock), "no caller: the server's default");
            assertThrows(RuntimeException.class, () -> owner.sql("UPDATE platform.community SET time_zone = 'Mars/Olympus' WHERE id = '" + other + "' RETURNING 1"), "an unknown zone is refused");
            var badZone = new com.communityos.api.shared.time.CommunityClock(Clock.fixed(at, ZoneId.of("Asia/Kolkata")), (cId) -> java.util.Optional.of("Mars/Olympus"));
            assertEquals(ZoneId.of("Asia/Kolkata"), as(nyJob, badZone::getZone), "and one that got in anyway falls back to the default");
            var nySummary = new com.communityos.api.summary.SummaryService(app, cclock);
            assertEquals(0, as(nyJob, () -> nySummary.tickets(nyJob)).total(), "the services take the zone from the clock");

            // ---- 12. the audit trail, a page at a time, newest first; only the office reads it ----------------------------------------------------------
            var trail = new com.communityos.api.auditlog.AuditLog(app, json);
            var none = new com.communityos.api.auditlog.AuditLog.Filter(null, null, null, null, null, null, null, null);
            var page1 = as(admin, () -> trail.list(admin, none, PageQuery.of(20, 0)));
            assertEquals(20, page1.items().size()); assertTrue(page1.total() > 20, "more than a page: " + page1.total());
            for (int k = 1; k < page1.items().size(); k++) assertFalse(page1.items().get(k).at().isAfter(page1.items().get(k - 1).at()), "newest first");
            var page2 = as(admin, () -> trail.list(admin, none, PageQuery.of(20, 20)));
            assertTrue(java.util.Collections.disjoint(page1.items().stream().map(com.communityos.api.auditlog.AuditLog.Entry::id).toList(), page2.items().stream().map(com.communityos.api.auditlog.AuditLog.Entry::id).toList()));
            var billsOnly = as(admin, () -> trail.list(admin, new com.communityos.api.auditlog.AuditLog.Filter(null, "billing", null, null, null, null, null, null), PageQuery.of(200, 0)));
            assertTrue(billsOnly.total() > 0 && billsOnly.items().stream().allMatch((e) -> e.entity().startsWith("billing.")), "one area");
            var unitTrail = as(admin, () -> trail.list(admin, new com.communityos.api.auditlog.AuditLog.Filter(null, null, null, null, unitA, today, today, null), PageQuery.of(200, 0)));
            assertTrue(unitTrail.total() > 0 && unitTrail.items().stream().allMatch((e) -> unitA.equals(e.unitId())), "one unit, today");
            assertEquals(0, as(admin, () -> trail.list(admin, new com.communityos.api.auditlog.AuditLog.Filter(null, null, null, null, null, today.plusDays(1), today.plusDays(2), null), PageQuery.of(20, 0))).total(), "nothing tomorrow");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> trail.list(ownerC, none, PageQuery.of(20, 0))));
            assertTrue(as(demoAdmin, () -> trail.list(demoAdmin, none, PageQuery.of(200, 0))).items().stream().noneMatch((e) -> page1.items().stream().anyMatch((x) -> x.id().equals(e.id()))), "another community's trail is its own");

            // ---- 13. unit numbers: blocks with a code and a pattern, the community's pattern, any case is the same unit, rename -----------------------------
            var tower = as(admin, () -> units.saveBlock(admin, null, null, new com.communityos.api.property.application.port.PropertySetup.BlockFields(" Tower  2 ", "T2", "Tower", 5, "{block}-{floor}{n:2}")));
            assertEquals("Tower 2", tower.name()); assertEquals("T2", tower.token());
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> units.saveBlock(admin, null, null, new com.communityos.api.property.application.port.PropertySetup.BlockFields("tower 2", null, "Tower", 0, null))), "a block name in another case");
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> units.saveBlock(admin, null, null, new com.communityos.api.property.application.port.PropertySetup.BlockFields("Tower 3", "t2", "Tower", 0, null))), "a code in another case");
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> units.saveBlock(ownerC, null, null, new com.communityos.api.property.application.port.PropertySetup.BlockFields("Mine", null, "Block", 0, null))));
            var naming = as(admin, () -> units.setNaming(admin, "Villa {n}", as(admin, () -> units.naming(admin)).version()));
            assertEquals("Villa {n}", naming.unitPattern());
            java.util.function.Function<String, com.communityos.api.property.application.port.PropertySetup.NewUnit> villa = (no) -> new com.communityos.api.property.application.port.PropertySetup.NewUnit(no, null, null, null, null);
            var oneNew = as(admin, () -> units.add(admin, List.of(villa.apply("  Villa   901 "))));
            assertEquals("Villa 901", oneNew.added().get(0).unitNo(), "trimmed, single spaces");
            assertEquals(List.of("villa 901"), as(admin, () -> units.add(admin, List.of(villa.apply("villa 901")))).skipped(), "the same unit whatever its case");
            var bad = assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> units.add(admin, List.of(villa.apply("Villa 902"), villa.apply("V903"), villa.apply("Villa #904")))));
            assertTrue(bad.getMessage().contains("2 problems") && bad.getMessage().contains("Villa {n}"), bad.getMessage());
            assertFalse(owner.sql("SELECT unit_no FROM property.unit WHERE community_id = '" + cid + "' AND unit_no = 'Villa 902'").size() > 0, "nothing of a refused batch is added");
            var inTower = as(admin, () -> units.add(admin, List.of(new com.communityos.api.property.application.port.PropertySetup.NewUnit("T2-1204", tower.id(), null, "Vacant", null),
                new com.communityos.api.property.application.port.PropertySetup.NewUnit("t2-1205", tower.id(), null, null, null), new com.communityos.api.property.application.port.PropertySetup.NewUnit("T2-1204", tower.id(), null, null, null))));
            assertEquals(2, inTower.added().size(), "the block's own pattern, not the community's"); assertEquals(List.of("T2-1204"), inTower.skipped(), "twice in one batch");
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> units.add(admin, List.of(new com.communityos.api.property.application.port.PropertySetup.NewUnit("Villa 905", tower.id(), null, null, null)))));
            assertThrows(AccessDenied.class, () -> as(ownerC, () -> units.add(ownerC, List.of(villa.apply("Villa 906")))));
            // renaming: checked the same way, audited; the unit keeps its id (bills, tickets and bookings point at it)
            UUID u901 = oneNew.added().get(0).id();
            var u0 = as(admin, () -> units.get(admin, new UnitId(u901)));
            var renamed = as(admin, () -> units.change(admin, new UnitId(u901), u0.version(), " Villa 911", new com.communityos.api.property.domain.Unit.Changes(null, null, null, null, null), Map.of()));
            assertEquals("Villa 911", renamed.unitNo()); assertEquals(u901, renamed.id().value());
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> units.change(admin, new UnitId(u901), renamed.version(), "VILLA 911x", new com.communityos.api.property.domain.Unit.Changes(null, null, null, null, null), Map.of())));
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> units.change(admin, new UnitId(u901), renamed.version(), "T2-1205", new com.communityos.api.property.domain.Unit.Changes(null, null, null, null, null), Map.of())), "not this block's pattern");
            UUID u912 = as(admin, () -> units.add(admin, List.of(villa.apply("Villa 912")))).added().get(0).id();
            var v912 = as(admin, () -> units.get(admin, new UnitId(u912)));
            var dup = assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> units.change(admin, new UnitId(u912), v912.version(), "villa 911", new com.communityos.api.property.domain.Unit.Changes(null, null, null, null, null), Map.of())));
            assertEquals("duplicate-unit", dup.code());
            assertTrue(owner.sql("SELECT changes::text AS c FROM audit.audit_event WHERE community_id = '" + cid + "' AND entity = 'property.unit' AND entity_id = '" + u901 + "' AND action = 'Update'").get(0).get("c").toString().contains("Villa 911"), "the rename is audited");
            // the database holds the same rules (whoever writes)
            assertThrows(RuntimeException.class, () -> owner.sql("INSERT INTO property.unit (community_id, unit_no, unit_type) VALUES ('" + cid + "', 'VILLA 911', 'Villa') RETURNING 1"), "any case is one unit");
            assertThrows(RuntimeException.class, () -> owner.sql("INSERT INTO property.unit (community_id, unit_no, unit_type) VALUES ('" + cid + "', ' Villa 913', 'Villa') RETURNING 1"), "spaces at the ends");
            assertThrows(DomainException.RuleViolated.class, () -> as(admin, () -> { units.deleteBlock(admin, tower.id(), tower.version()); return null; }), "a block with units stays");
            as(admin, () -> units.setNaming(admin, null, as(admin, () -> units.naming(admin)).version()));
            // names compare whatever their case: a filter typed in lower case finds the same tickets
            var asTyped = as(admin, () -> ticketSvc.list(admin, new com.communityos.api.maintenance.application.port.TicketRepository.Filter(null, false, "PLUMBING", null, null, null, null), PageQuery.of(200, 0))).total();
            assertEquals(as(admin, () -> ticketSvc.list(admin, new com.communityos.api.maintenance.application.port.TicketRepository.Filter(null, false, "Plumbing", null, null, null, null), PageQuery.of(200, 0))).total(), asTyped);
            assertTrue(asTyped > 0);
            // e-mail addresses are kept in lower case, whoever writes them
            owner.sql("UPDATE identity.person SET email = '  Asha.Owner.' || '" + tag + "' || '@Example.COM ' WHERE id = '" + persons[0] + "' RETURNING 1");
            assertEquals("asha.owner." + tag.toLowerCase() + "@example.com", owner.sql("SELECT email::text AS e FROM identity.person WHERE id = '" + persons[0] + "'").get(0).get("e"));

            System.out.println("flow: " + (app.statements + platform.statements) + " statements through cos_app / cos_platform");
        }
    }
    static UUID id(PsqlJdbc s, String sql) { return UUID.fromString((String) s.sql(sql).get(0).get("id")); }
}
