package com.communityos.amenities;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The amenity scheduler and the messages, in small readable cases (the big replay against the JavaScript is AmenityNotifyConformanceTest). */
class AmenitySchedulerTest {
    static final ZoneId IST = ZoneId.of("Asia/Kolkata");
    final ObjectMapper json = new ObjectMapper();
    DocumentRepository repo;
    Instant now;
    AmenityNotifier notifier;
    AmenityScheduler scheduler;

    Clock clock() { return new Clock() {
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId z) { return this; }
        public Instant instant() { return now; }
    }; }

    @BeforeEach void setUp() throws Exception {
        repo = new InMemoryDocumentRepository();
        now = Instant.parse("2026-10-19T12:00:00Z");   // Monday 17:30 in India
        Constants constants = Constants.load(json);
        AmenitySystem system = new AmenitySystem(repo, new AuditTrail(repo, json, clock()), clock(), constants);
        notifier = new AmenityNotifier(repo, system, json);
        scheduler = new AmenityScheduler(repo, notifier, system, json, null);
    }

    ObjectNode row(String coll, String json0) throws Exception {
        ObjectNode o = (ObjectNode) json.readTree(json0.replace('\'', '"'));
        repo.upsert("t", coll, o.get("id").asText(), o);
        return o;
    }
    JsonNode booking(String id) { return repo.get("t", "amenities", id).orElseThrow(); }
    List<JsonNode> outbox() { return repo.list("t", "notificationOutbox"); }

    @Test void aCommunityWithNothingSetUpGetsTheDefaultSettingsAndMessages() {
        scheduler.run("t", IST);
        assertEquals(1, repo.list("t", "amenitySettings").size());
        assertEquals(48, repo.list("t", "amenitySettings").get(0).get("paymentDueHours").asInt());
        assertEquals(49, repo.list("t", "notificationTemplates").size());
        scheduler.run("t", IST);   // and only once
        assertEquals(1, repo.list("t", "amenitySettings").size());
        assertEquals(49, repo.list("t", "notificationTemplates").size());
    }

    @Test void anUnpaidBookingIsReleasedAfterTheGracePeriodAndItsCreditGoesBack() throws Exception {
        scheduler.ensureDefaults("t");
        row("properties", "{'id':'p1','unit':'A-101','owner':'Mr Rao','ownerPhone':'+919800000000'}");
        row("amenities", "{'id':'b1','shortId':'BKG-0001','amenity':'Clubhouse','date':'2026-10-25','slot':'10:00 - 11:00','unit':'A-101','status':'Pending payment','paymentStatus':'Pending','creditApplied':300,'recordCreatedAt':'2026-10-17T11:00:00.000Z'}");
        row("amenities", "{'id':'b2','shortId':'BKG-0002','amenity':'Clubhouse','date':'2026-10-26','slot':'10:00 - 11:00','unit':'A-101','status':'Pending payment','paymentStatus':'Pending','recordCreatedAt':'2026-10-18T13:00:00.000Z'}");   // 47 hours old: not yet
        AmenityScheduler.Stats s = scheduler.run("t", IST);
        assertEquals(1, s.released());
        JsonNode b1 = booking("b1");
        assertEquals("Cancelled", b1.get("status").asText());
        assertEquals("Cancelled", b1.get("paymentStatus").asText());
        assertEquals("Payment not received within 48 hours", b1.get("cancelReason").asText());
        assertEquals("System · amenity bookings", b1.get("lastUpdatedBy").asText());
        assertEquals("Pending payment", booking("b2").get("status").asText());
        List<JsonNode> credits = repo.list("t", "unitCredits");
        assertEquals(1, credits.size());
        assertEquals("Credit", credits.get(0).get("type").asText());
        assertEquals(300, credits.get(0).get("amount").asInt());
        assertTrue(outbox().stream().anyMatch(o -> "payment_expired".equals(o.get("event").asText()) && "WhatsApp".equals(o.get("channel").asText()) && "+919800000000".equals(o.get("to").asText())),
                "the owner is told on WhatsApp");
        assertEquals(0, scheduler.run("t", IST).released());
    }

    @Test void aPastConfirmedBookingIsCompletedAndTomorrowsGetsOneReminder() throws Exception {
        scheduler.ensureDefaults("t");
        ObjectNode settings = (ObjectNode) repo.list("t", "amenitySettings").get(0);
        settings.put("reminderOn", true);
        repo.upsert("t", "amenitySettings", settings.get("id").asText(), settings);
        row("properties", "{'id':'p1','unit':'A-101','owner':'Mr Rao','ownerPhone':'+919800000000'}");
        row("amenities", "{'id':'old','shortId':'BKG-0001','amenity':'Pool','date':'2026-10-18','slot':'Full day','unit':'A-101','status':'Confirmed','paymentStatus':'Paid','recVersion':2}");
        row("amenities", "{'id':'today','shortId':'BKG-0002','amenity':'Pool','date':'2026-10-19','slot':'Full day','unit':'A-101','status':'Confirmed','paymentStatus':'Paid'}");
        row("amenities", "{'id':'tmr','shortId':'BKG-0003','amenity':'Pool','date':'2026-10-20','slot':'Full day','unit':'A-101','status':'Confirmed','paymentStatus':'Paid'}");
        AmenityScheduler.Stats s = scheduler.run("t", IST);
        assertEquals(1, s.completed());
        assertEquals(1, s.reminders());
        assertEquals("Completed", booking("old").get("status").asText());
        assertEquals(3, booking("old").get("recVersion").asInt());
        assertEquals("Confirmed", booking("today").get("status").asText());   // today is not over yet
        assertTrue(booking("tmr").get("reminderSent").asBoolean());
        long reminders = outbox().stream().filter(o -> "reminder".equals(o.get("event").asText())).count();
        assertEquals(2, reminders, "WhatsApp to the owner, and an e-mail row stored as skipped (no address); SMS is off by default)");
        assertEquals(1, outbox().stream().filter(o -> "reminder".equals(o.get("event").asText()) && o.get("status").asText().startsWith("Queued")).count());
        AmenityScheduler.Stats again = scheduler.run("t", IST);
        assertEquals(0, again.reminders());
        assertEquals(reminders, outbox().stream().filter(o -> "reminder".equals(o.get("event").asText())).count(), "never twice");
    }

    @Test void theDailyReportGoesOnceADayAndOnlyFromTheSetTime() throws Exception {
        scheduler.ensureDefaults("t");
        ObjectNode settings = (ObjectNode) repo.list("t", "amenitySettings").get(0);
        settings.put("dailyReport", true);
        settings.putArray("reportRecipients").addObject().put("channel", "WhatsApp").put("target", "+919800000001").put("label", "Secretary");
        repo.upsert("t", "amenitySettings", settings.get("id").asText(), settings);
        row("amenities", "{'id':'b','shortId':'BKG-0001','amenity':'Pool','date':'2026-10-19','slot':'17:30 - 18:30','unit':'A-101','status':'Confirmed','paymentStatus':'Paid'}");
        assertFalse(scheduler.run("t", IST).daily(), "17:30 is before 20:00");
        now = Instant.parse("2026-10-19T14:30:00Z");   // 20:00 in India
        assertTrue(scheduler.run("t", IST).daily());
        assertFalse(scheduler.run("t", IST).daily(), "already sent today");
        JsonNode sent = outbox().stream().filter(o -> "daily_report".equals(o.get("event").asText())).findFirst().orElseThrow();
        assertEquals("+919800000001", sent.get("to").asText());
        assertEquals("Secretary", sent.get("toLabel").asText());
        assertTrue(sent.get("body").asText().contains("*Today (1)*"), sent.get("body").asText());
        assertEquals("2026-10-19", repo.list("t", "amenitySettings").get(0).get("lastDailyRun").asText());
        now = Instant.parse("2026-10-20T14:45:00Z");   // the next day
        assertTrue(scheduler.run("t", IST).daily());
    }

    @Test void aTemplateTurnedOffOrAMissingAddressQueuesNothingToSend() throws Exception {
        scheduler.ensureDefaults("t");
        row("amenities", "{'id':'b','shortId':'BKG-0001','amenity':'Pool','date':'2026-10-25','slot':'Full day','unit':'Z-999','status':'Pending payment','paymentStatus':'Pending','paymentMode':'Cash','totalPayable':500}");
        notifier.notify("t", "booking_pending", booking("b"), repo.list("t", "amenitySettings").get(0), "", null);
        // e-mail and WhatsApp owner templates are on (SMS is off): nobody lives in Z-999, so both are stored as skipped, not sent
        List<JsonNode> rows = outbox();
        assertEquals(2, rows.size());
        assertTrue(rows.stream().allMatch(o -> o.get("status").asText().startsWith("Skipped")));
        assertEquals(2, repo.list("t", "notifications").size(), "the unit's bell and the managers' bell");
    }

    @Test void theGstLineAndTheTokensRenderAsInTheWebApp() {
        assertEquals("GST breakdown: taxable ₹1,000 + CGST 9% ₹90 + SGST 9% ₹90 = ₹1,180", AmenityTemplates.taxBreakdownLine(json.getNodeFactory().numberNode(1000), json.getNodeFactory().numberNode(18), json.getNodeFactory().textNode("Exclusive")));
        assertEquals("GST breakdown: taxable ₹1,000 + CGST 9% ₹90 + SGST 9% ₹90 = ₹1,180 (tax included in the price)", AmenityTemplates.taxBreakdownLine(json.getNodeFactory().numberNode(1180), json.getNodeFactory().numberNode(18), json.getNodeFactory().textNode("Inclusive")));
        assertEquals("", AmenityTemplates.taxBreakdownLine(json.getNodeFactory().numberNode(1000), json.getNodeFactory().numberNode(0), json.getNodeFactory().textNode("Exclusive")));
        assertEquals("Hi Asha, ₹5!", AmenityTemplates.render("Hi {{ owner }}, {{refund}}{{REFUND}}{{nope}}!", java.util.Map.of("owner", "Asha", "refund", "₹5")));
    }
}
