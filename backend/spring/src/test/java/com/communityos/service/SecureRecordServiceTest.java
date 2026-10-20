package com.communityos.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.communityos.access.AuthzDeniedException;
import com.communityos.access.CommunityMetaLoader;
import com.communityos.access.PrincipalResolver;
import com.communityos.access.ServerHooks;
import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.config.AppProperties;
import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.payments.BookingClaims;
import com.communityos.payments.FinanceSettlement;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.security.WriteRules;
import com.communityos.service.SecureRecordService.WriteOptions;
import com.communityos.service.audit.AuditTrail;
import com.communityos.web.ConflictException;
import com.communityos.web.NotFoundException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * The secure read/write path end to end, with no Spring context and no database: real rules, real stamping, the in-memory repository.
 * People are signed in with a token whose claims match a `users` record, as an OpenID Connect sign-in would.
 */
class SecureRecordServiceTest {
    static final String C = "la-paloma";
    final ObjectMapper json = new ObjectMapper();
    final DocumentRepository repo = new InMemoryDocumentRepository();
    final Clock clock = Clock.fixed(Instant.parse("2026-10-19T12:00:00Z"), ZoneOffset.UTC);

    /** The online payments the bookings in a test can claim: PAY-1 (Rs 5,000 for A-101) is free until a booking takes it. */
    BookingClaims claims = (tenant, ref, unit, amount, bookingId) -> "PAY-1".equals(ref) && "A-101".equals(unit) && amount.doubleValue() <= 5000 ? "" : "That payment was not found. Pay online first, then book.";

    com.communityos.evoting.RandomSource randomSource = com.communityos.evoting.RandomSource.secure();
    com.communityos.evoting.EVotingState evotingState = new com.communityos.evoting.InMemoryEVotingState();

    private SecureRecordService service(String unportedHooks) throws Exception {
        AppProperties props = new AppProperties(new AppProperties.Storage("memory", List.of("communities"), false), null, null, null, null,
                new AppProperties.Security("jwt", null, "community", "subject,phone,email", unportedHooks, 0L), null, null, null, null, null, null);
        Constants constants = Constants.load(json);
        CommunityMetaLoader metas = new CommunityMetaLoader(repo, json, constants, clock, props);
        return new SecureRecordService(repo, metas, new PrincipalResolver(props, repo), new WriteRules(constants), new ServerHooks(props, java.util.Set.of("vendors")), new AuditTrail(repo, json, clock),
                Tx.none(), json, clock, constants, props, new FinanceSettlement(repo, new AuditTrail(repo, json, clock), json, clock, constants), claims,
                evotingState, randomSource);
    }

    private JsonNode j(String s) throws Exception { return json.readTree(s); }

    private void seedPeople() throws Exception {
        repo.upsert(C, "users", "u-asha", j("{\"id\":\"u-asha\",\"name\":\"Asha\",\"roleId\":\"owner\",\"units\":[\"A-101\"],\"email\":\"asha@x.in\"}"));
        repo.upsert(C, "users", "u-tre", j("{\"id\":\"u-tre\",\"name\":\"Tara\",\"roleId\":\"treasurer\",\"email\":\"tara@x.in\"}"));
        repo.upsert(C, "users", "u-boss", j("{\"id\":\"u-boss\",\"name\":\"Boss\",\"roleId\":\"super_admin\",\"email\":\"boss@x.in\"}"));
    }

    private static Authentication as(String email) {
        Jwt jwt = Jwt.withTokenValue("t").header("alg", "none").claim("sub", "sub-" + email).claim("email", email).build();
        return new JwtAuthenticationToken(jwt);
    }

    private List<JsonNode> auditRows() { return repo.list(C, "audit"); }

    @Test
    void aResidentSeesOnlyTheirOwnVillasBills() throws Exception {
        seedPeople();
        repo.upsert(C, "dues", "d1", j("{\"id\":\"d1\",\"unit\":\"A-101\",\"amount\":1000,\"status\":\"Open\"}"));
        repo.upsert(C, "dues", "d2", j("{\"id\":\"d2\",\"unit\":\"B-201\",\"amount\":300,\"status\":\"Open\"}"));
        SecureRecordService s = service("refuse");
        List<JsonNode> mine = s.list(C, as("asha@x.in"), "dues");
        assertEquals(1, mine.size());
        assertEquals("d1", mine.get(0).get("id").asText());
        assertThrows(NotFoundException.class, () -> s.get(C, as("asha@x.in"), "dues", "d2"));
        PageResult page = s.query(C, as("asha@x.in"), "dues", new QuerySpec(1, 50, "", "asc", "", List.of(), "", "", "", "", "", "", Map.of()));
        assertEquals(1, page.total());
        assertEquals(2, s.list(C, as("tara@x.in"), "dues").size());   // the Treasurer sees every bill
    }

    @Test
    void aPropertySaveChecksThePhonesAndInvitesTheNewNumber() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        Exception bad = assertThrows(AccessDeniedException.class, () -> s.put(C, as("boss@x.in"), "properties",
                j("{\"id\":\"p1\",\"unit\":\"C-7\",\"owner\":\"Meena\",\"ownerPhone\":\"98450 71234\",\"occupancy\":\"Owner occupied\"}"), WriteOptions.NONE));
        assertTrue(bad.getMessage().contains("Start with the country code"), bad.getMessage());
        JsonNode p = s.put(C, as("boss@x.in"), "properties", j("{\"id\":\"p1\",\"unit\":\"C-7\",\"owner\":\"Meena\",\"ownerPhone\":\"+91 98450 71234\",\"occupancy\":\"Owner occupied\"}"), WriteOptions.NONE);
        assertEquals("+919845071234", p.get("ownerPhone").asText());
        JsonNode invited = repo.list(C, "users").stream().filter((u) -> "+919845071234".equals(u.path("phone").asText())).findFirst().orElseThrow();
        assertEquals("Invited", invited.get("status").asText());
        assertEquals("C-7", invited.get("units").get(0).asText());
        assertEquals(1, repo.list(C, "portalInvites").size());
        List<JsonNode> out = repo.list(C, "notificationOutbox");
        assertEquals(2, out.size());
        assertTrue(out.get(0).get("body").asText().contains("http://localhost:5173/#/join/"), out.get(0).get("body").asText());
        assertTrue(auditRows().stream().anyMatch((a) -> "Portal access".equals(a.path("what").asText())));
    }

    @Test
    void aPublishedMeetingIsAnnouncedToResidentsAndAnInternalOneIsNot() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        s.put(C, as("boss@x.in"), "meetings", j("{\"id\":\"m1\",\"title\":\"EC sync\",\"date\":\"2026-11-02\",\"visibility\":\"Internal (committee only)\"}"), WriteOptions.NONE);
        assertEquals(0, repo.list(C, "notifications").size());
        JsonNode m = s.put(C, as("boss@x.in"), "meetings", j("{\"id\":\"m2\",\"title\":\"AGM\",\"committee\":\"General body\",\"date\":\"2026-11-09\",\"visibility\":\"Published to residents\"}"), WriteOptions.NONE);
        assertEquals("2026-10-19T12:00:00.000Z", m.get("publishedAt").asText());
        List<JsonNode> n = repo.list(C, "notifications");
        assertEquals(1, n.size());
        assertEquals("New meeting · AGM", n.get(0).get("title").asText());
    }

    @Test
    void aSignInWithNoAccountIsTurnedAway() throws Exception {
        seedPeople();
        AccessDeniedException e = assertThrows(AccessDeniedException.class, () -> service("refuse").list(C, as("stranger@x.in"), "dues"));
        assertTrue(e.getMessage().contains("no account"));
    }

    @Test
    void aWriteIsStampedNumberedAndAudited() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        JsonNode a = s.put(C, as("asha@x.in"), "serviceContacts", j("{\"id\":\"c1\",\"name\":\"Plumber\",\"addedBy\":\"Asha\",\"status\":\"Active\"}"), WriteOptions.NONE);
        assertEquals(1, a.get("recVersion").asInt());
        assertTrue(a.get("shortId").asText().endsWith("-0001"));
        assertTrue(a.get("recordCreatedBy").asText().startsWith("Asha"));
        JsonNode b = s.put(C, as("asha@x.in"), "serviceContacts", j("{\"id\":\"c2\",\"name\":\"Electrician\",\"addedBy\":\"Asha\",\"status\":\"Active\"}"), WriteOptions.NONE);
        assertTrue(b.get("shortId").asText().endsWith("-0002"));
        assertEquals(2, auditRows().size());
        assertEquals("Create", auditRows().get(0).get("action").asText());
        assertTrue(auditRows().get(0).get("shortId").asText().startsWith("AUD-"));
        assertEquals("2026-10-19T12:00:00.000Z", a.get("lastUpdatedAt").asText());
    }

    @Test
    void anUnchangedSaveWritesNothing() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        JsonNode a = s.put(C, as("asha@x.in"), "serviceContacts", j("{\"id\":\"c1\",\"name\":\"Plumber\",\"addedBy\":\"Asha\",\"status\":\"Active\"}"), WriteOptions.NONE);
        int audits = auditRows().size();
        JsonNode again = s.put(C, as("asha@x.in"), "serviceContacts", j("{\"id\":\"c1\",\"name\":\"Plumber\",\"addedBy\":\"Asha\",\"status\":\"Active\",\"recVersion\":1}"), WriteOptions.NONE);
        assertEquals(a.get("recVersion").asInt(), again.get("recVersion").asInt());
        assertEquals(audits, auditRows().size());
    }

    @Test
    void aStaleVersionIsAConflict() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        s.put(C, as("asha@x.in"), "serviceContacts", j("{\"id\":\"c1\",\"name\":\"Plumber\",\"addedBy\":\"Asha\",\"status\":\"Active\"}"), WriteOptions.NONE);
        s.put(C, as("asha@x.in"), "serviceContacts", j("{\"id\":\"c1\",\"name\":\"Plumber 2\",\"addedBy\":\"Asha\",\"status\":\"Active\",\"recVersion\":1}"), WriteOptions.NONE);   // now version 2
        ConflictException e = assertThrows(ConflictException.class,
                () -> s.put(C, as("asha@x.in"), "serviceContacts", j("{\"id\":\"c1\",\"name\":\"Plumber 3\",\"addedBy\":\"Asha\",\"status\":\"Active\",\"recVersion\":1}"), WriteOptions.NONE));
        assertEquals(2, e.current().get("recVersion").asInt());
        assertEquals("Plumber 2", repo.get(C, "serviceContacts", "c1").get().get("name").asText());   // the stale save changed nothing
    }

    @Test
    void aRefusedWriteIsExplainedAndRecordedInTheAuditTrail() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class,
                () -> s.put(C, as("asha@x.in"), "culturalEvents", j("{\"id\":\"e1\",\"name\":\"Diwali\"}"), WriteOptions.NONE));
        assertEquals("Requires permission: MANAGE_CULTURAL", e.getMessage());
        assertTrue(repo.get(C, "culturalEvents", "e1").isEmpty());
        assertEquals(1, auditRows().size());
        assertEquals("Denied", auditRows().get(0).get("action").asText());
        assertTrue(auditRows().get(0).get("summary").asText().contains("Requires permission: MANAGE_CULTURAL"));
    }

    @Test
    void residentsCannotWriteBillsDirectly() throws Exception {
        seedPeople();
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class,
                () -> service("refuse").put(C, as("asha@x.in"), "dues", j("{\"id\":\"d9\",\"unit\":\"A-101\",\"amount\":1,\"status\":\"Paid\"}"), WriteOptions.NONE));
        assertTrue(e.getMessage().startsWith("Payments are confirmed by the payment service"));
    }

    @Test
    void checksSpringCannotRunYetRefuseTheWriteUnlessAllowed() throws Exception {
        seedPeople();
        String vendor = "{\"id\":\"v1\",\"name\":\"Lift Co\"}";   // the test hooks guard "vendors": the mechanism stays even though nothing real is guarded now
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class, () -> service("refuse").put(C, as("boss@x.in"), "vendors", j(vendor), WriteOptions.NONE));
        assertTrue(e.getMessage().contains("not available on this server yet"));
        JsonNode saved = service("allow").put(C, as("boss@x.in"), "vendors", j(vendor), WriteOptions.NONE);
        assertEquals("v1", saved.get("id").asText());
    }

    /** A task whose quotation (Rs 100) the EC and the Treasurer have approved. */
    private void seedApprovedTask() throws Exception {
        repo.upsert(C, "tickets", "t1", j("{\"id\":\"t1\",\"ticketNumber\":\"TKT-1\",\"status\":\"In Progress\",\"financial\":true,\"selectedQuotationId\":\"q1\",\"ecApproval\":\"Approved\",\"treasurerApproval\":\"Approved\"}"));
        repo.upsert(C, "quotations", "q1", j("{\"id\":\"q1\",\"ticketId\":\"t1\",\"kind\":\"Quotation\",\"amount\":100}"));
    }

    @Test
    void aReleaseCannotPassTheApprovedAmountEvenForTheSuperAdmin() throws Exception {
        seedPeople();
        seedApprovedTask();
        SecureRecordService s = service("refuse");
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class,
                () -> s.put(C, as("boss@x.in"), "releases", j("{\"id\":\"r1\",\"ticketId\":\"t1\",\"status\":\"Waiting approval\",\"amount\":500}"), WriteOptions.NONE));
        assertTrue(e.getMessage().startsWith("Only \u20b9100 of \u20b9100 (the quotation amount) is left"), e.getMessage());
        assertTrue(repo.get(C, "releases", "r1").isEmpty());
        assertEquals("Denied", auditRows().get(auditRows().size() - 1).get("action").asText());
        JsonNode ok = s.put(C, as("boss@x.in"), "releases", j("{\"id\":\"r1\",\"ticketId\":\"t1\",\"status\":\"Waiting approval\",\"amount\":60}"), WriteOptions.NONE);
        assertEquals(60, ok.get("amount").asInt());
        // 60 of 100 is now asked for: another 60 does not fit
        AuthzDeniedException again = assertThrows(AuthzDeniedException.class,
                () -> s.put(C, as("boss@x.in"), "releases", j("{\"id\":\"r2\",\"ticketId\":\"t1\",\"status\":\"Waiting approval\",\"amount\":60}"), WriteOptions.NONE));
        assertTrue(again.getMessage().startsWith("Only \u20b940 of \u20b9100"), again.getMessage());
    }

    @Test
    void aRecordedPaymentCannotBeDeletedOnlyReversed() throws Exception {
        seedPeople();
        seedApprovedTask();
        repo.upsert(C, "ledger", "l1", j("{\"id\":\"l1\",\"type\":\"Debit\",\"amount\":40,\"account\":\"A\",\"taskRef\":\"TKT-1\",\"sourceType\":\"task\",\"sourceId\":\"t1\"}"));
        SecureRecordService s = service("refuse");
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class, () -> s.delete(C, as("boss@x.in"), "ledger", "l1"));
        assertTrue(e.getMessage().startsWith("A recorded payment cannot be deleted"), e.getMessage());
        JsonNode reversal = s.put(C, as("boss@x.in"), "ledger", j("{\"id\":\"l2\",\"type\":\"Credit\",\"amount\":40,\"account\":\"A\",\"reversalOf\":\"l1\",\"reason\":\"wrong vendor\"}"), WriteOptions.NONE);
        assertEquals("l1", reversal.get("reversalOf").asText());
    }

    @Test
    void aTaskWithMoneyOutCannotBeCancelledAndBulkWritesAreCheckedToo() throws Exception {
        seedPeople();
        seedApprovedTask();
        repo.upsert(C, "releases", "r1", j("{\"id\":\"r1\",\"ticketId\":\"t1\",\"status\":\"Approved\",\"amount\":70}"));
        SecureRecordService s = service("refuse");
        JsonNode t1 = repo.get(C, "tickets", "t1").orElseThrow().deepCopy();   // a copy: the in-memory store hands out its own node
        ((com.fasterxml.jackson.databind.node.ObjectNode) t1).put("status", "Cancelled");
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("boss@x.in"), "tickets", t1, WriteOptions.NONE));
        assertTrue(e.getMessage().contains("is released or paid on this task"), e.getMessage());
        AuthzDeniedException bulk = assertThrows(AuthzDeniedException.class,
                () -> s.createMany(C, as("boss@x.in"), "releases", List.of(j("{\"id\":\"r9\",\"ticketId\":\"t1\",\"status\":\"Waiting approval\",\"amount\":90}")), WriteOptions.NONE));
        assertTrue(bulk.getMessage().startsWith("Only \u20b930 of \u20b9100"), bulk.getMessage());
    }

    /** A clubhouse booked for a whole day at Rs 1,000 + 18% GST with a Rs 2,000 deposit. */
    private void seedClubhouse() throws Exception {
        repo.upsert(C, "amenityTypes", "at1", j("{\"id\":\"at1\",\"name\":\"Clubhouse\",\"bookingMode\":\"Full day\",\"rateUnit\":\"Per day / event\",\"rate\":1000,\"gstApplicable\":true,\"gstRate\":18,\"gstMode\":\"Exclusive\",\"depositAmount\":2000,\"hours\":\"06:00 - 22:00\"}"));
        repo.upsert(C, "properties", "p1", j("{\"id\":\"p1\",\"unit\":\"A-101\",\"type\":\"Villa\",\"owner\":\"Asha\"}"));
    }

    private static final String BOOK = "{\"id\":\"bk1\",\"amenity\":\"Clubhouse\",\"date\":\"2026-11-02\",\"slot\":\"Full day\",\"unit\":\"A-101\",\"paymentMode\":\"UPI\",\"paymentRef\":\"PAY-1\",\"totalPayable\":1,\"feeTotal\":1,\"paidAmount\":1}";

    @Test
    void aBookingIsPricedByTheServerAndItsMoneyIsPostedWithIt() throws Exception {
        seedPeople();
        seedClubhouse();
        SecureRecordService s = service("refuse");
        JsonNode booked = s.put(C, as("asha@x.in"), "amenities", j(BOOK), WriteOptions.NONE);
        assertEquals(1180, booked.get("feeTotal").asInt());              // the browser's Rs 1 is ignored
        assertEquals(2000, booked.get("depositAmount").asInt());
        assertEquals(3180, booked.get("totalPayable").asInt());
        assertEquals("Paid", booked.get("paymentStatus").asText());
        assertEquals("Confirmed", booked.get("status").asText());
        assertEquals("Held", booked.get("depositStatus").asText());
        assertEquals("Asha", booked.get("bookedBy").asText());
        List<JsonNode> ledger = repo.list(C, "ledger");
        assertEquals(2, ledger.size());                                  // the fee (with its GST) and the deposit, as separate lines
        JsonNode fee = ledger.stream().filter(l -> l.get("sourceId").asText().endsWith(":fee")).findFirst().orElseThrow();
        assertEquals("Credit", fee.get("type").asText());
        assertEquals(1180, fee.get("amount").asInt());
        assertEquals(1000, fee.get("baseAmount").asInt());
        assertEquals(180, fee.get("gstAmount").asInt());
        assertTrue(fee.get("shortId").asText().startsWith("LED-"));
        assertEquals("System · amenity bookings", fee.get("recordCreatedBy").asText());
        assertTrue(auditRows().stream().anyMatch(a -> "Payments Cross-check".equals(a.path("what").asText()) || "ledger".equals(a.path("collection").asText())));
    }

    @Test
    void aBookingQueuesItsMessagesAndRingsTheBellInTheSameTransaction() throws Exception {
        seedPeople();
        seedClubhouse();
        for (com.fasterxml.jackson.databind.node.ObjectNode t : com.communityos.amenities.AmenityTemplates.defaultTemplates()) repo.upsert(C, "notificationTemplates", t.get("id").asText(), t);
        repo.upsert(C, "properties", "p1", j("{\"id\":\"p1\",\"ownerPhone\":\"+919800000000\"}"));
        repo.upsert(C, "amenitySettings", "as1", j("{\"id\":\"as1\",\"adminRecipients\":[{\"channel\":\"WhatsApp\",\"target\":\"+919800000009\",\"label\":\"Manager\"}]}"));
        SecureRecordService s = service("refuse");
        s.put(C, as("asha@x.in"), "amenities", j(BOOK), WriteOptions.NONE);
        List<JsonNode> out = repo.list(C, "notificationOutbox");
        JsonNode toOwner = out.stream().filter(o -> "booking_confirmed".equals(o.path("event").asText()) && "Owner".equals(o.path("audience").asText()) && "WhatsApp".equals(o.path("channel").asText())).findFirst().orElseThrow();
        assertTrue(toOwner.get("body").asText().contains("\u20b91,180"), toOwner.get("body").asText());   // the price the SERVER worked out, not the browser's Rs 1
        assertTrue(toOwner.get("status").asText().startsWith("Queued") || toOwner.get("status").asText().startsWith("Skipped"));
        assertTrue(toOwner.get("shortId").asText().startsWith("OUT-"));
        assertTrue(out.stream().anyMatch(o -> "Admin".equals(o.path("audience").asText()) && "+919800000009".equals(o.path("to").asText())), "the manager is told too");
        assertEquals(2, repo.list(C, "notifications").size());   // the unit's bell and the managers' bell
    }

    @Test
    void cancellingWithEnoughNoticeRefundsEverythingToTheUnitAccount() throws Exception {
        seedPeople();
        seedClubhouse();
        SecureRecordService s = service("refuse");
        JsonNode booked = s.put(C, as("asha@x.in"), "amenities", j(BOOK), WriteOptions.NONE);
        com.fasterxml.jackson.databind.node.ObjectNode cancel = booked.deepCopy();
        cancel.put("_action", "cancel").put("cancelReason", "Plans changed");
        JsonNode done = s.put(C, as("asha@x.in"), "amenities", cancel, WriteOptions.NONE);
        assertEquals("Cancelled", done.get("status").asText());
        assertEquals(100, done.get("refundPct").asInt());
        assertEquals(3180, done.get("refundAmount").asInt());            // the whole fee and the deposit
        assertEquals("Credited to unit account", done.get("refundStatus").asText());
        assertEquals("Refunded", done.get("paymentStatus").asText());
        List<JsonNode> credits = repo.list(C, "unitCredits");
        assertEquals(1, credits.size());
        assertEquals("Credit", credits.get(0).get("type").asText());
        assertEquals(3180, credits.get(0).get("amount").asInt());
        assertEquals("A-101", credits.get(0).get("unit").asText());
        // the receipt (2 lines) plus the non-cash debit and the "held as credit" line
        assertEquals(4, repo.list(C, "ledger").size());
    }

    @Test
    void anOwnerCannotMarkAPaymentReceivedAndAnUnknownPaymentCannotPayABooking() throws Exception {
        seedPeople();
        seedClubhouse();
        SecureRecordService s = service("refuse");
        AuthzDeniedException noPay = assertThrows(AuthzDeniedException.class,
                () -> s.put(C, as("asha@x.in"), "amenities", j(BOOK.replace("PAY-1", "PAY-NOPE")), WriteOptions.NONE));
        assertTrue(noPay.getMessage().startsWith("That payment was not found"), noPay.getMessage());
        assertTrue(repo.get(C, "amenities", "bk1").isEmpty());
        assertTrue(repo.list(C, "ledger").isEmpty());
        JsonNode office = s.put(C, as("asha@x.in"), "amenities", j(BOOK.replace("UPI", "Cash").replace("\"bk1\"", "\"bk2\"")), WriteOptions.NONE);
        assertEquals("Pending", office.get("paymentStatus").asText());
        com.fasterxml.jackson.databind.node.ObjectNode receive = office.deepCopy();
        receive.put("_action", "receive_payment");
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("asha@x.in"), "amenities", receive, WriteOptions.NONE));
        assertEquals("Residents can only cancel their booking", e.getMessage());   // the permission rules answer first; the booking rules would say "Requires amenities management access"
        JsonNode paid = s.put(C, as("boss@x.in"), "amenities", receive, WriteOptions.NONE);
        assertEquals("Paid", paid.get("paymentStatus").asText());
        assertEquals(2, repo.list(C, "ledger").size());
    }

    @Test
    void bookingsCannotBeWrittenInBulk() throws Exception {
        seedPeople();
        seedClubhouse();
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class,
                () -> service("refuse").createMany(C, as("boss@x.in"), "amenities", List.of(j(BOOK)), WriteOptions.NONE));
        assertTrue(e.getMessage().startsWith("Amenity bookings are made and changed one at a time"));
    }

    @Test
    void aVillaWithLongOverdueDuesCannotBookButTheTeamCan() throws Exception {
        seedPeople();
        seedClubhouse();
        repo.upsert(C, "financeSettings", "fs1", j("{\"id\":\"fs1\",\"blockDefaulters\":true,\"blockOverdueDays\":30,\"blockOverdueAmount\":1000}"));
        repo.upsert(C, "dues", "d1", j("{\"id\":\"d1\",\"unit\":\"A-101\",\"status\":\"Open\",\"amount\":12000,\"dueDate\":\"2026-06-01\"}"));
        SecureRecordService s = service("refuse");
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("asha@x.in"), "amenities", j(BOOK), WriteOptions.NONE));
        assertTrue(e.getMessage().startsWith("Booking is on hold for A-101: \u20b912,000 has been overdue for 140 days."), e.getMessage());
        assertEquals("Confirmed", s.put(C, as("boss@x.in"), "amenities", j(BOOK), WriteOptions.NONE).get("status").asText());
    }

    @Test
    void closedBooksRefuseALedgerEntryEvenForTheSuperAdmin() throws Exception {
        seedPeople();
        repo.upsert(C, "financeSettings", "fs1", j("{\"id\":\"fs1\",\"lockedUntil\":\"2026-03-31\"}"));
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class,
                () -> service("allow").put(C, as("boss@x.in"), "ledger", j("{\"id\":\"l1\",\"date\":\"2026-03-01\",\"type\":\"Credit\",\"amount\":10}"), WriteOptions.NONE));
        assertTrue(e.getMessage().startsWith("The books are closed up to 31 Mar 2026"));
    }

    @Test
    void auditTrailCannotBeDeleted() throws Exception {
        seedPeople();
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class, () -> service("refuse").delete(C, as("boss@x.in"), "audit", "a1"));
        assertEquals("The audit trail can never be edited or deleted", e.getMessage());
    }

    @Test
    void aRoleChangeTakesEffectAtOnce() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        // the Treasurer may edit the final-approver list; a resident may not
        s.put(C, as("tara@x.in"), "approverSettings", j("{\"id\":\"ap1\",\"roles\":[\"treasurer\",\"president\"]}"), WriteOptions.NONE);
        assertThrows(AuthzDeniedException.class, () -> s.put(C, as("asha@x.in"), "approverSettings", j("{\"id\":\"ap1\",\"roles\":[\"owner\"]}"), WriteOptions.NONE));
        assertFalse(auditRows().isEmpty());
    }

    @Test
    void aBillMarkedPaidByTheFinanceTeamGetsItsLedgerLineAndLosesItWhenReopened() throws Exception {
        seedPeople();
        repo.upsert(C, "dues", "d1", j("{\"id\":\"d1\",\"unit\":\"A-101\",\"amount\":1000,\"status\":\"Unpaid\",\"category\":\"Maintenance\",\"dueDate\":\"2026-10-01\",\"shortId\":\"DUE-0001\",\"recVersion\":1}"));
        SecureRecordService s = service("refuse");
        s.put(C, as("tara@x.in"), "dues", j("{\"id\":\"d1\",\"unit\":\"A-101\",\"amount\":1000,\"status\":\"Paid\",\"category\":\"Maintenance\",\"dueDate\":\"2026-10-01\",\"paymentMode\":\"Cash\",\"paidAt\":\"2026-10-19\"}"), WriteOptions.NONE);
        List<JsonNode> ledger = repo.list(C, "ledger");
        assertEquals(1, ledger.size());
        assertEquals("due:d1", ledger.get(0).get("sourceId").asText());
        assertEquals("Cash", ledger.get(0).get("mode").asText());
        assertEquals("2026-10-19", ledger.get(0).get("date").asText());
        s.put(C, as("tara@x.in"), "dues", j("{\"id\":\"d1\",\"unit\":\"A-101\",\"amount\":1000,\"status\":\"Unpaid\",\"category\":\"Maintenance\",\"dueDate\":\"2026-10-01\"}"), WriteOptions.NONE);
        assertEquals(0, repo.list(C, "ledger").size());
    }

    // ---- e-voting: the whole flow through the service, as the screens use it -------------------------------------------------------------

    private JsonNode ballotWith(String key, String value) {
        return ((com.fasterxml.jackson.databind.node.ObjectNode) repo.get(C, "ballots", "b1").get().deepCopy()).put(key, value);
    }

    private com.communityos.evoting.OtpService otp() {
        return new com.communityos.evoting.OtpService(evotingState, repo, Tx.none(), clock, randomSource, null, "echo");
    }

    /** A ballot open today, with a roll of two units (Asha owns A-101). */
    private void openBallot(SecureRecordService s) throws Exception {
        String roll = "[{\"unit\":\"A-101\",\"owners\":[\"Asha\"],\"phones\":{\"Asha\":\"1234\"},\"phoneLast4\":\"1234\"},{\"unit\":\"B-201\",\"owners\":[\"Bimal\"],\"phones\":{},\"phoneLast4\":\"\"}]";
        String hash = com.communityos.evoting.EVotingRules.rollHash(j(roll));
        s.put(C, as("boss@x.in"), "ballots", j("{\"id\":\"b1\",\"title\":\"Lift\",\"kind\":\"Resolution\",\"options\":[\"For\",\"Against\"],\"opensOn\":\"2026-10-19\",\"closesOn\":\"2026-10-19\","
                + "\"quorumPct\":10,\"passPct\":50,\"status\":\"Draft\",\"roll\":" + roll + ",\"rollHash\":\"" + hash + "\"}"), WriteOptions.NONE);
        s.put(C, as("boss@x.in"), "ballots", j("{\"id\":\"b1\",\"title\":\"Lift\",\"kind\":\"Resolution\",\"options\":[\"For\",\"Against\"],\"opensOn\":\"2026-10-19\",\"closesOn\":\"2026-10-19\","
                + "\"quorumPct\":10,\"passPct\":50,\"status\":\"Open\",\"roll\":" + roll + ",\"rollHash\":\"" + hash + "\"}"), WriteOptions.NONE);
    }

    @Test
    void aVoteNeedsTheSecondFactorAndTheBoxStaysSealedUntilTheBallotIsClosed() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        openBallot(s);
        assertEquals("2026-10-19", repo.get(C, "ballots", "b1").get().get("openedAt").asText());
        com.communityos.security.Principal asha = s.principal(C, as("asha@x.in"));

        // no proof, no mark
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("asha@x.in"), "voteRoll", j("{\"id\":\"m0\",\"ballotId\":\"b1\",\"unit\":\"A-101\"}"), WriteOptions.NONE));
        assertEquals("Second-factor check missing or expired - request a new code", e.getMessage());
        // and no vote without a mark
        e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("asha@x.in"), "ballotBox", j("{\"id\":\"x0\",\"ballotId\":\"b1\",\"choice\":\"For\"}"), WriteOptions.NONE));
        assertEquals("No verified voter roll mark for this ballot", e.getMessage());

        String code = otp().request(C, asha, "b1").code();
        assertEquals(6, code.length());
        String proof = otp().verify(C, asha, "b1", code);
        JsonNode mark = s.put(C, as("asha@x.in"), "voteRoll", j("{\"id\":\"m1\",\"ballotId\":\"b1\",\"unit\":\"A-101\",\"proof\":\"" + proof + "\"}"), new WriteOptions("Voter roll", "Voted on Lift"));
        assertEquals("Asha", mark.get("owner").asText());
        assertEquals("2026-10-19", mark.get("markedOn").asText());
        assertTrue(!mark.has("proof"), "the proof is used up and never stored");
        assertTrue(auditRows().stream().anyMatch((a) -> "voteRoll".equals(a.path("collection").asText())), "a roll mark is audited");

        JsonNode vote = s.put(C, as("asha@x.in"), "ballotBox", j("{\"id\":\"x1\",\"ballotId\":\"b1\",\"choice\":\"For\"}"), WriteOptions.NONE);
        assertEquals(1, vote.get("seq").asInt());
        assertEquals(12, vote.get("receipt").asText().length());
        assertEquals(com.communityos.evoting.EVotingRules.GENESIS, vote.get("prevHash").asText());
        assertEquals("Ballot box", vote.get("recordCreatedBy").asText());
        assertTrue(vote.get("recordCreatedAt").asText().length() == 10, "only the day, never the time");
        assertTrue(!vote.has("unit"), "a vote carries no voter");
        assertTrue(auditRows().stream().noneMatch((a) -> "ballotBox".equals(a.path("collection").asText())), "the box is never attributed to anyone");

        // sealed for everyone, the Super Admin included
        assertEquals(0, s.list(C, as("boss@x.in"), "ballotBox").size());
        // one vote per villa; marks and votes can never be changed or deleted
        e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("asha@x.in"), "voteRoll", j("{\"id\":\"m2\",\"ballotId\":\"b1\",\"unit\":\"A-101\"}"), WriteOptions.NONE));
        assertTrue(e.getMessage().contains("already voted"));
        e = assertThrows(AuthzDeniedException.class, () -> s.delete(C, as("boss@x.in"), "ballotBox", "x1"));
        assertEquals("Voting records can never be changed or deleted", e.getMessage());
        e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("boss@x.in"), "ballotBox", j("{\"id\":\"x1\",\"ballotId\":\"b1\",\"choice\":\"Against\"}"), WriteOptions.NONE));
        assertEquals("Voting records can never be changed or deleted", e.getMessage());
        e = assertThrows(AuthzDeniedException.class, () -> s.createMany(C, as("boss@x.in"), "ballotBox", List.of(j("{\"ballotId\":\"b1\",\"choice\":\"For\"}")), WriteOptions.NONE));
        assertTrue(e.getMessage().contains("one at a time"));

        // closing seals the chain and opens the box
        JsonNode closed = s.put(C, as("boss@x.in"), "ballots", ballotWith("status", "Closed"), WriteOptions.NONE);
        assertEquals(vote.get("hash").asText(), closed.get("chainHead").asText());
        assertEquals(1, closed.get("votesCounted").asInt());
        assertEquals(1, s.list(C, as("boss@x.in"), "ballotBox").size());
        e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("boss@x.in"), "ballots", ballotWith("title", "Other"), WriteOptions.NONE));
        assertEquals("A closed ballot can never be changed", e.getMessage());
    }

    @Test
    void aTenantAnOpenBallotEditAndAForgedRollFingerprintAreAllRefused() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        AuthzDeniedException e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("boss@x.in"), "ballots", j("{\"id\":\"b9\",\"title\":\"X\",\"options\":[\"For\",\"Against\"],\"status\":\"Open\",\"roll\":[{\"unit\":\"A-101\",\"owners\":[\"Asha\"]}],\"rollHash\":\"forged\"}"), WriteOptions.NONE));
        assertEquals("The voter roll does not match its fingerprint", e.getMessage());
        openBallot(s);
        e = assertThrows(AuthzDeniedException.class, () -> s.put(C, as("boss@x.in"), "ballots", ballotWith("title", "Changed"), WriteOptions.NONE));
        assertEquals("An open ballot cannot be edited", e.getMessage());
        com.communityos.security.Principal tina = new com.communityos.security.Principal("tenant", null, "Tina", "A-101", List.of());
        com.communityos.web.BadRequestException b = assertThrows(com.communityos.web.BadRequestException.class, () -> otp().request(C, tina, "b1"));
        assertTrue(b.getMessage().startsWith("Only registered owners can vote"));
    }

    @Test
    void threeWrongCodesBurnTheCodeAndAProofWorksOnce() throws Exception {
        seedPeople();
        SecureRecordService s = service("refuse");
        openBallot(s);
        com.communityos.security.Principal asha = s.principal(C, as("asha@x.in"));
        String code = otp().request(C, asha, "b1").code();
        String wrong = code.equals("111111") ? "222222" : "111111";
        for (int i = 2; i >= 0; i--) {
            final int left = i;
            com.communityos.web.BadRequestException b = assertThrows(com.communityos.web.BadRequestException.class, () -> otp().verify(C, asha, "b1", wrong));
            assertTrue(b.getMessage().contains("(" + left + " attempt"), b.getMessage());   // the try is counted even though the answer is a refusal
        }
        com.communityos.web.BadRequestException b = assertThrows(com.communityos.web.BadRequestException.class, () -> otp().verify(C, asha, "b1", code));
        assertEquals("Too many wrong attempts. Ask for a new code.", b.getMessage());
        // a burnt code can be replaced at once, but a code that is still alive is not re-sent for 30 seconds
        String fresh = otp().request(C, asha, "b1").code();
        assertEquals(6, fresh.length());
        b = assertThrows(com.communityos.web.BadRequestException.class, () -> otp().request(C, asha, "b1"));
        assertTrue(b.getMessage().startsWith("Please wait"));
    }
}
