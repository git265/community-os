package com.communityos.api.comms;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.billing.domain.BillingEvents;
import com.communityos.api.comms.application.CommsPolicy;
import com.communityos.api.comms.application.Notifier;
import com.communityos.api.comms.application.Recipes;
import com.communityos.api.comms.application.port.Facts;
import com.communityos.api.comms.application.port.Inbox;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.gate.application.GateService.GateEvent;
import com.communityos.api.maintenance.domain.TicketEvents;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Notices, notifications and the forum: who is told what, and the rules a notice, a poll and a topic follow. */
class CommsTest {
    static final Instant NOW = Instant.parse("2026-10-20T06:00:00Z");
    static final UUID TICKET = UUID.randomUUID(), RAISER = UUID.randomUUID(), PLUMBER = UUID.randomUUID();
    static final Facts FACTS = (kind, id) -> switch (kind) {
        case TICKET -> Optional.of(new Facts.Fact("TKT-1001", "Leaking tap", Fixtures.UNIT_A.value(), "Villa 101", RAISER, PLUMBER, null));
        case GATE_APPROVAL -> Optional.of(new Facts.Fact("GAP-1", "Ravi", Fixtures.UNIT_A.value(), "Villa 101", null, null, "Main gate"));
        case GATE_VISIT -> Optional.of(new Facts.Fact("VIS-1", "Lakshmi", Fixtures.UNIT_A.value(), "Villa 101", null, null, null));
        case GATE_FLAG -> Optional.of(new Facts.Fact("FLG-1", "Thief", null, null, null, null, "at Main gate"));
        case BOOKING -> Optional.of(new Facts.Fact("BKG-1", "Clubhouse", Fixtures.UNIT_A.value(), "Villa 101", null, null, "Evening"));
    };

    @Test void recipes() {
        var raised = Recipes.of(new TicketEvents.TicketRaised(TICKET, Fixtures.COMMUNITY, Fixtures.UNIT_A, "Plumbing", "High", "Unit", NOW), FACTS);
        assertEquals(1, raised.size());
        assertEquals("ticket_new", raised.get(0).event()); assertEquals(Set.of("facility_manager", "helpdesk"), raised.get(0).to().roles());
        assertEquals("#/ticket/TKT-1001", raised.get(0).link()); assertEquals("Leaking tap — Villa 101", raised.get(0).body());
        var assigned = Recipes.of(new TicketEvents.TicketAssigned(TICKET, Fixtures.COMMUNITY, new MembershipId(PLUMBER), "Plumbing", NOW), FACTS).get(0);
        assertEquals(Set.of(PLUMBER), assigned.to().members());
        var status = Recipes.of(new TicketEvents.TicketStatusChanged(TICKET, Fixtures.COMMUNITY, "Open", "Resolved", NOW), FACTS).get(0);
        assertEquals("TKT-1001 is now Resolved", status.title()); assertEquals(Set.of(RAISER), status.to().members(), "the person who raised it");
        var internal = Recipes.of(new TicketEvents.CommentAdded(TICKET, UUID.randomUUID(), Fixtures.COMMUNITY, "Internal", NOW), FACTS).get(0);
        assertEquals(Set.of(PLUMBER), internal.to().members(), "an internal note is not shown to the resident");
        var bill = Recipes.of(new BillingEvents.DueRaised(new DueId(UUID.randomUUID()), Fixtures.COMMUNITY, Fixtures.UNIT_A, UUID.randomUUID(), UUID.randomUUID(), Money.of("3000"),
            Money.of("540"), LocalDate.of(2026, 10, 1), LocalDate.of(2026, 10, 15), NOW), FACTS).get(0);
        assertEquals("New bill · ₹3,540", bill.title()); assertEquals(Set.of(Fixtures.UNIT_A.value()), bill.to().units());
        assertTrue(bill.body().contains("Oct 2026") && bill.body().contains("2026-10-15"), bill.body());
        // the gate
        var ask = Recipes.of(new GateEvent("gate.approval.requested", UUID.randomUUID(), Fixtures.COMMUNITY, Fixtures.UNIT_A.value(), "Guest", "Pending", NOW), FACTS).get(0);
        assertEquals("gate_approval", ask.event()); assertEquals("At the gate: Ravi", ask.title()); assertEquals(Set.of(Fixtures.UNIT_A.value()), ask.to().units());
        assertTrue(Recipes.of(new GateEvent("gate.visit.exited", UUID.randomUUID(), Fixtures.COMMUNITY, Fixtures.UNIT_A.value(), "Delivery", "Exited", NOW), FACTS).isEmpty(),
            "only a guest leaving is worth telling");
        var flag = Recipes.of(new GateEvent("gate.flag.raised", UUID.randomUUID(), Fixtures.COMMUNITY, null, "Blocked person attempt", "Open", NOW), FACTS).get(0);
        assertEquals("gate_blocked", flag.event()); assertEquals(Set.of("committee_security", "facility_manager"), flag.to().roles());
        assertEquals("gate_overstay", Recipes.of(new GateEvent("gate.flag.raised", UUID.randomUUID(), Fixtures.COMMUNITY, null, "Overstay", "Open", NOW), FACTS).get(0).event());
        assertTrue(Recipes.of(new GateEvent("gate.pass.created", UUID.randomUUID(), Fixtures.COMMUNITY, null, null, null, NOW), FACTS).isEmpty(), "no recipe: nobody is told");
    }

    @Test void notifierSkipsNobody() {
        List<Comms.Message> sent = new ArrayList<>();
        Inbox inbox = new Inbox() {
            @Override public int deliver(Comms.Message m) { sent.add(m); return 1; }
            @Override public List<Comms.Note> mine(UUID m, boolean u, int l) { return List.of(); }
            @Override public int unread(UUID m) { return 0; }
            @Override public int markRead(UUID m, UUID id) { return 0; }
        };
        Facts noRaiser = (k, id) -> Optional.of(new Facts.Fact("TKT-1", "x", null, null, null, null, null));
        new Notifier(inbox, noRaiser).on(new TicketEvents.TicketStatusChanged(TICKET, Fixtures.COMMUNITY, "Open", "Closed", NOW));
        assertTrue(sent.isEmpty(), "a ticket nobody raised (an import) tells nobody");
        new Notifier(inbox, FACTS).on(new TicketEvents.TicketStatusChanged(TICKET, Fixtures.COMMUNITY, "Open", "Closed", NOW));
        assertEquals(1, sent.size());
    }

    @Test void messages() {
        assertThrows(IllegalArgumentException.class, () -> new Comms.Message("ticket_new", "x", "t", "b", "https://evil.example", null, Comms.To.nobody()), "links stay inside the app");
        assertThrows(IllegalArgumentException.class, () -> new Comms.Message("made_up", "x", "t", "b", null, null, Comms.To.nobody()));
        assertEquals(200, new Comms.Message("bill", "x", "a".repeat(300), "b", null, null, Comms.To.nobody()).title().length());
        assertEquals(Comms.To.unit(Fixtures.UNIT_A.value()).and(Comms.To.roles("helpdesk")), new Comms.To(Set.of(), Set.of(Fixtures.UNIT_A.value()), Set.of("helpdesk")));
    }

    static Comms.Broadcast notice(String type, String audience) {
        Comms.Broadcast b = new Comms.Broadcast(); b.type = type; b.audience = audience; b.subject = "Water cut"; b.message = "<p>Tomorrow</p>"; return b;
    }
    @Test void notices() {
        notice("Announcement", "All residents").check();
        Comms.Broadcast empty = notice("Announcement", "All residents"); empty.message = "<p> </p>";
        assertEquals("message-required", assertThrows(DomainException.RuleViolated.class, empty::check).code());
        assertEquals("units-required", assertThrows(DomainException.RuleViolated.class, notice("Notice", "Selected villas")::check).code());
        assertEquals("bad-audience", assertThrows(DomainException.RuleViolated.class, notice("Notice", "Everyone")::check).code());
        Comms.Broadcast m = notice("Scheduled maintenance", "All residents");
        assertEquals("date-required", assertThrows(DomainException.RuleViolated.class, m::check).code());
        m.eventDate = LocalDate.of(2026, 10, 22); m.startTime = "10:00"; m.endTime = "09:00";
        assertEquals("bad-times", assertThrows(DomainException.RuleViolated.class, m::check).code());
        m.endTime = "13:00"; m.check();
        Comms.Broadcast p = notice("Poll", "Owners"); p.message = null; p.pollOptions = List.of("Yes", " yes ");
        assertEquals("poll-options", assertThrows(DomainException.RuleViolated.class, p::check).code(), "answers must differ");
        p.pollOptions = List.of("Yes", "No", " "); p.check();
        assertEquals(List.of("Yes", "No"), p.pollOptions, "blank answers dropped");
        p.status = "Sent"; p.pollClosesOn = LocalDate.of(2026, 10, 25);
        assertEquals(List.of("1"), p.choices(List.of("1"), LocalDate.of(2026, 10, 25)), "open on its closing day");
        assertEquals("poll-closed", assertThrows(DomainException.RuleViolated.class, () -> p.choices(List.of("1"), LocalDate.of(2026, 10, 26))).code());
        assertEquals("one-answer", assertThrows(DomainException.RuleViolated.class, () -> p.choices(List.of("0", "1"), LocalDate.of(2026, 10, 20))).code());
        assertEquals("bad-choice", assertThrows(DomainException.RuleViolated.class, () -> p.choices(List.of("2"), LocalDate.of(2026, 10, 20))).code());
        p.pollMultiple = true; assertEquals(List.of("0", "1"), p.choices(List.of("0", "1", "0"), LocalDate.of(2026, 10, 20)));
    }

    @Test void forum() {
        Comms.Topic t = new Comms.Topic(); t.title = "  Pool timings  "; t.kind = "Poll"; t.check();
        assertEquals("Pool timings", t.title); assertEquals(List.of("Yes", "No"), t.pollOptions, "a poll without answers is yes / no");
        Comms.Topic short_ = new Comms.Topic(); short_.title = "Hi";
        assertEquals("title-required", assertThrows(DomainException.RuleViolated.class, short_::check).code());
        assertEquals("body-required", assertThrows(DomainException.RuleViolated.class, () -> Comms.Post.checkBody("<p></p>")).code());
    }

    @Test void policy() {
        Caller owner = Fixtures.owner(Fixtures.UNIT_A);
        assertFalse(CommsPolicy.publisher(owner)); assertTrue(CommsPolicy.member(owner)); assertFalse(CommsPolicy.moderator(owner));
        assertTrue(CommsPolicy.publisher(Fixtures.treasurer()), "the committee sends notices");
        assertFalse(CommsPolicy.publisher(Fixtures.helpdesk()));
        assertTrue(CommsPolicy.moderator(Fixtures.caller(Caller.Category.Resident, Set.of("owner"), Set.of(), Set.of(), Permission.MODERATE_FORUM)));
        assertFalse(CommsPolicy.member(Fixtures.caller(Caller.Category.Vendor, Set.of("vendor"), Set.of(), Set.of())));
    }
}
