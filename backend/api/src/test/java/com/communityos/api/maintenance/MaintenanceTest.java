package com.communityos.api.maintenance;

import static com.communityos.api.Fixtures.*;
import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.maintenance.application.TicketPolicy;
import com.communityos.api.maintenance.application.TicketService;
import com.communityos.api.maintenance.application.port.CommentRepository;
import com.communityos.api.maintenance.application.port.MaintenanceDirectory;
import com.communityos.api.maintenance.application.port.TicketRepository;
import com.communityos.api.maintenance.domain.Comment;
import com.communityos.api.maintenance.domain.TaskType;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.maintenance.domain.TicketStatus;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The ticket rules, with in-memory adapters that apply the access Spec exactly where the SQL would. */
class MaintenanceTest {
    static final TaskType RESIDENT = new TaskType(UUID.randomUUID(), "Resident Maintenance", "🔧", "Resident", "Role queue (staff accepts)", "No", "No", "No", "No", "No", true, true, true);
    static final TaskType PURCHASE = new TaskType(UUID.randomUUID(), "Purchase", "🧾", "EC / Staff", "Direct assign", "Optional", "Yes", "Yes", "Yes", "Yes", false, false, true);

    final Map<UUID, Ticket> rows = new LinkedHashMap<>();
    final List<Comment> posted = new ArrayList<>();
    final Caller plumber = caller(Caller.Category.Staff, Set.of("handyman_plumbing"), Set.of(), Set.of(), "Plumbing");
    final Caller plumber2 = caller(Caller.Category.Staff, Set.of("handyman_plumbing"), Set.of(), Set.of(), "Plumbing");
    final Caller electrician = caller(Caller.Category.Staff, Set.of("handyman_electrical"), Set.of(), Set.of(), "Electrical");
    final Caller fm = caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of(), null, Permission.MANAGE_TICKETS);
    final Caller treasurer = treasurer();
    final Caller owner = owner(UNIT_A);
    final Caller neighbour = owner(UNIT_B);
    boolean plumberClockedIn = true;
    Clock clock = CLOCK;

    static Caller caller(Caller.Category cat, Set<String> roles, Set<UnitId> units, Set<com.communityos.api.shared.domain.Ids.BlockId> blocks, String trade, Permission... perms) {
        Caller c = Fixtures.caller(cat, roles, units, blocks, perms);
        return new Caller(c.person(), c.membership(), c.community(), c.displayName(), c.category(), c.roleCodes(), c.permissions(), c.units(), c.blocks(), trade, Set.of());
    }

    final TicketRepository repo = new TicketRepository() {
        public Page<Ticket> find(Spec<Ticket> s, Filter f, PageQuery p) { List<Ticket> l = rows.values().stream().filter(s::matches).toList(); return new Page<>(l, l.size(), 50, 0); }
        public Optional<Ticket> findById(UUID id, Spec<Ticket> s) { return Optional.ofNullable(rows.get(id)).filter(s::matches); }
        int n = 1050;
        public void insert(Ticket t) { t.numbered("TKT-" + (++n)); t.stored(1); t.state().version = 1; rows.put(t.id(), t); }
        public boolean save(Ticket t) { t.stored(t.version() + 1); t.state().version = t.version(); return true; }
        public boolean signOff(UUID id, long version, String value, UUID by) {
            Ticket t = rows.get(id); Ticket.Approval a = t.state().approval;
            t.state().approval = new Ticket.Approval(a.quotationStatus(), a.invoiceStatus(), a.approvedAmount(), a.selectedQuotationId(), a.selectedInvoiceId(), value, a.treasurerApproval(), a.finalRequired());
            return save(t);
        }
    };
    final CommentRepository comments = new CommentRepository() {
        public List<Comment> ofTicket(UUID id, boolean internal) { return posted.stream().filter((c) -> c.ticketId().equals(id) && (internal || !c.internal())).toList(); }
        public List<Comment> recent(Spec<Ticket> s, boolean internal, int limit) { return posted.stream().filter((c) -> s.matches(rows.get(c.ticketId())) && (internal || !c.internal())).toList(); }
        public Comment insert(UUID t, MembershipId a, String v, String b) { Comment c = new Comment(UUID.randomUUID(), "CMT-" + posted.size(), t, a, "x", v, b, CLOCK.instant()); posted.add(c); return c; }
    };
    final MaintenanceDirectory dir = new MaintenanceDirectory() {
        public List<TaskType> taskTypes() { return List.of(RESIDENT, PURCHASE); }
        public Optional<TaskType> taskType(UUID id) { return taskTypes().stream().filter((t) -> t.id().equals(id)).findFirst(); }
        public Optional<UnitRef> unit(UnitId id) { return Optional.of(new UnitRef(id, id.equals(UNIT_A) ? "Villa 1" : "Villa 2", id.equals(UNIT_A) ? BLOCK_1 : BLOCK_2)); }
        public List<Candidate> candidates(String category, boolean internal) {
            List<Candidate> out = new ArrayList<>();
            if (!internal && category.equals("Plumbing")) { out.add(new Candidate(plumber.membership(), "Ravi Plumber", "Field staff", plumberClockedIn, "Plumbing")); out.add(new Candidate(plumber2.membership(), "Sam Plumber", "Field staff", false, "Plumbing")); }
            out.add(new Candidate(fm.membership(), "Farah FM", "Coordinator", false, null));
            if (internal) out.add(new Candidate(treasurer.membership(), "Tia Treasurer", "EC", false, null));
            return out;
        }
        public Set<String> finalApproverRoles() { return Set.of("treasurer", "president"); }
        public Optional<String> memberName(MembershipId id) { return Optional.of("x"); }
    };
    final Fixtures.Outbox outbox = new Fixtures.Outbox();
    final com.communityos.api.maintenance.application.port.TaskMoney.Position[] money = {position(0, 0)};
    static com.communityos.api.maintenance.application.port.TaskMoney.Position position(long committed, int open) {
        com.communityos.api.shared.domain.Money z = com.communityos.api.shared.domain.Money.ZERO, c = com.communityos.api.shared.domain.Money.of(committed);
        return new com.communityos.api.maintenance.application.port.TaskMoney.Position("None", z, z, z, c, z, c, c, null, open);
    }
    final com.communityos.api.maintenance.application.port.TaskMoney taskMoney = new com.communityos.api.maintenance.application.port.TaskMoney() {
        public Position position(UUID ticketId) { return money[0]; }
        public com.communityos.api.shared.domain.Money paidOn(UUID documentId) { return com.communityos.api.shared.domain.Money.ZERO; }
    };
    /** dispatch over the rows: Ravi (on shift when plumberClockedIn) and Sam (off) are the plumbers; busy = holding an Assigned / In Progress ticket */
    boolean samClockedIn = false;
    final com.communityos.api.maintenance.application.port.DispatchStore dispatch = new com.communityos.api.maintenance.application.port.DispatchStore() {
        int busy(MembershipId m) { return (int) rows.values().stream().filter((t) -> m.equals(t.assignee()) && (t.status() == TicketStatus.ASSIGNED || t.status() == TicketStatus.IN_PROGRESS)).count(); }
        public List<com.communityos.api.maintenance.domain.Dispatch.Tech> techs(String category) {
            if (!category.equals("Plumbing")) return List.of();
            return List.of(new com.communityos.api.maintenance.domain.Dispatch.Tech(plumber.membership(), "Ravi Plumber", plumberClockedIn, busy(plumber.membership()), null, null),
                new com.communityos.api.maintenance.domain.Dispatch.Tech(plumber2.membership(), "Sam Plumber", samClockedIn, busy(plumber2.membership()), null, null));
        }
        public void lock(String category) { }
        public List<UUID> queued(String category, int limit) {
            return rows.values().stream().filter((t) -> t.status() == TicketStatus.OPEN && t.assignee() == null && t.category().equals(category) && t.taskType().queue()).map(Ticket::id).limit(limit).toList();
        }
        public List<String> queuedCategories() { return rows.values().stream().filter((t) -> t.status() == TicketStatus.OPEN && t.assignee() == null && t.taskType().queue()).map(Ticket::category).distinct().toList(); }
        public List<UUID> offShiftAssigned() { return List.of(); }
        public List<Active> active() { return List.of(); }
        public boolean claim(UUID ticket, String kind, int stage, java.time.Instant since) { return true; }
        public List<Row> queueView(String category, java.time.Instant since) { return List.of(); }
    };
    TicketService svc() { return new TicketService(repo, comments, dir, taskMoney, dispatch, Fixtures.events(List.of(), outbox), new Fixtures.Audit(), Tx.direct(), clock); }

    Ticket leak(Caller who) { return svc().raise(who, new TicketService.RaiseTicket(null, "Leak in kitchen", "Water under the sink", null, "Unit", null, "Plumbing", null, "High", null, null)); }

    @Test void statusMachine() {
        assertTrue(TicketStatus.OPEN.canMoveTo(TicketStatus.ASSIGNED)); assertFalse(TicketStatus.OPEN.canMoveTo(TicketStatus.CLOSED));
        assertTrue(TicketStatus.COMPLETED.canMoveTo(TicketStatus.CLOSED)); assertFalse(TicketStatus.CLOSED.canMoveTo(TicketStatus.COMPLETED));
        assertTrue(TicketStatus.CANCELLED.canMoveTo(TicketStatus.OPEN));
    }

    @Test void residentRaisesForOwnUnitAndALoneClockedInPlumberGetsIt() {
        plumberClockedIn = true;
        Ticket t = leak(owner);
        assertEquals("TKT-1051", t.shortId()); assertEquals(UNIT_A, t.unit());
        assertEquals(TicketStatus.ASSIGNED, t.status(), "exactly one clocked-in plumber -> assigned");
        assertEquals(plumber.membership(), t.assignee());
        assertTrue(outbox.events.stream().anyMatch((e) -> e.topic().equals("maintenance.ticket.assigned")));
        assertThrows(AccessDenied.class, () -> svc().raise(owner, new TicketService.RaiseTicket(null, "Leak next door", null, UNIT_B, "Unit", null, "Plumbing", null, null, null, null)), "not my unit");
        assertThrows(AccessDenied.class, () -> svc().raise(owner, new TicketService.RaiseTicket(PURCHASE.id(), "Buy a pump", null, null, "Unit", null, "Plumbing", null, null, null, null)), "internal type");
        assertThrows(DomainException.class, () -> svc().raise(owner, new TicketService.RaiseTicket(null, "Street light", null, null, "Community", " ", "Electrical", null, null, null, null)), "community needs a place");
        assertThrows(AccessDenied.class, () -> svc().raise(owner, new TicketService.RaiseTicket(null, "Leak", null, null, "Unit", null, "Plumbing", null, null, null, LocalDate.of(2026, 12, 1))), "SLA is the committee's");
        assertThrows(AccessDenied.class, () -> svc().raise(plumber, new TicketService.RaiseTicket(PURCHASE.id(), "Buy a pipe", null, null, "Community", "Store", "Plumbing", null, null, null, null)), "a handyman does not raise tasks");
        assertThrows(DomainException.class, () -> leak(fm), "no default task type a Facility Manager may raise");
        Ticket internal = svc().raise(fm, new TicketService.RaiseTicket(PURCHASE.id(), "Replace DG battery", null, null, "Community", "DG room", "MEP", null, null, null, LocalDate.of(2026, 11, 1)));
        assertEquals(TicketStatus.OPEN, internal.status(), "direct-assign types are never auto-assigned");
    }

    @Test void aBusyPlumberLeavesTheNextTicketInTheQueueAndTakesItWhenDone() {
        plumberClockedIn = true;
        Ticket first = leak(owner);
        assertEquals(plumber.membership(), first.assignee(), "Ravi is free: the first leak is his");
        Ticket second = leak(owner);
        assertEquals(TicketStatus.OPEN, second.status(), "Ravi is busy and Sam is off shift: the second waits in the queue");
        Ticket started = svc().changeStatus(plumber, first.id(), first.version(), TicketStatus.IN_PROGRESS, null);
        assertEquals(TicketStatus.OPEN, rows.get(second.id()).status(), "still busy while the first is in progress");
        svc().changeStatus(plumber, first.id(), started.version(), TicketStatus.COMPLETED, null);
        assertEquals(TicketStatus.ASSIGNED, rows.get(second.id()).status(), "the first done: the next in the queue goes to Ravi");
        assertEquals(plumber.membership(), rows.get(second.id()).assignee());
        Ticket third = leak(owner);
        samClockedIn = true;
        assertEquals(1, svc().dispatchAll(com.communityos.api.shared.security.SystemCaller.of(owner.community(), "ticket dispatch")), "Sam clocks in: the job gives him the waiting one");
        assertEquals(plumber2.membership(), rows.get(third.id()).assignee());
        var free = new com.communityos.api.maintenance.domain.Dispatch.Tech(plumber.membership(), "B", true, 0, java.time.Instant.parse("2026-10-01T10:00:00Z"), null);
        var idle = new com.communityos.api.maintenance.domain.Dispatch.Tech(plumber2.membership(), "A", true, 0, java.time.Instant.parse("2026-10-01T08:00:00Z"), null);
        assertEquals("A", com.communityos.api.maintenance.domain.Dispatch.next(List.of(free, idle)).orElseThrow().name(), "the one waiting longest since a job");
        var lim = com.communityos.api.maintenance.domain.Dispatch.Limits.of(null, null);
        java.time.Instant at = java.time.Instant.parse("2026-10-01T10:00:00Z");
        assertTrue(com.communityos.api.maintenance.domain.Dispatch.due("Assigned", at, null, lim, at.plusSeconds(29 * 60)).isEmpty(), "30 minutes to start");
        assertEquals(1, com.communityos.api.maintenance.domain.Dispatch.due("Assigned", at, null, lim, at.plusSeconds(31 * 60)).orElseThrow().stage());
        assertEquals(2, com.communityos.api.maintenance.domain.Dispatch.due("Assigned", at, null, lim, at.plusSeconds(61 * 60)).orElseThrow().stage(), "twice that: the facility manager too");
        assertEquals("fix", com.communityos.api.maintenance.domain.Dispatch.due("In Progress", at, at, lim, at.plusSeconds(4 * 3600)).orElseThrow().kind());
    }

    @Test void twoPlumbersOnDutyMeansNobodyIsPickedAndTheyTakeItFromTheQueue() {
        plumberClockedIn = false;
        Ticket t = leak(owner);
        assertEquals(TicketStatus.OPEN, t.status());
        Ticket taken = svc().assign(plumber2, t.id(), t.version(), plumber2.membership());
        assertEquals(TicketStatus.ASSIGNED, taken.status());
        assertThrows(AccessDenied.class, () -> svc().assign(electrician, t.id(), taken.version(), electrician.membership()), "another trade's queue");
        Ticket handed = svc().assign(plumber2, t.id(), taken.version(), plumber.membership());
        assertEquals(plumber.membership(), handed.assignee(), "hand to a colleague of the same trade");
        assertThrows(DomainException.class, () -> svc().assign(fm, t.id(), handed.version(), electrician.membership()), "not eligible for Plumbing");
        assertThrows(DomainException.Conflict.class, () -> svc().assign(fm, t.id(), 1, plumber2.membership()), "stale version");
    }

    @Test void workFlowAndWhoMayCloseOrCancel() {
        plumberClockedIn = true;
        Ticket t = leak(owner);
        assertThrows(AccessDenied.class, () -> svc().changeStatus(plumber2, t.id(), t.version(), TicketStatus.IN_PROGRESS, null), "not the assignee");
        Ticket w = svc().changeStatus(plumber, t.id(), t.version(), TicketStatus.IN_PROGRESS, null);
        assertNotNull(w.state().startedAt);
        Ticket done = svc().changeStatus(plumber, t.id(), w.version(), TicketStatus.COMPLETED, null);
        assertNotNull(done.state().completedAt);
        assertThrows(AccessDenied.class, () -> svc().changeStatus(plumber, t.id(), done.version(), TicketStatus.CLOSED, null), "the assignee cannot close");
        assertThrows(AccessDenied.class, () -> svc().changeStatus(neighbour, t.id(), done.version(), TicketStatus.CLOSED, null), "not visible / not mine");
        Ticket closed = svc().changeStatus(owner, t.id(), done.version(), TicketStatus.CLOSED, null);
        assertEquals(TicketStatus.CLOSED, closed.status());
        assertThrows(AccessDenied.class, () -> svc().changeStatus(fm, t.id(), closed.version(), TicketStatus.OPEN, null), "only the EC reopens");
        Ticket reopened = svc().changeStatus(treasurer, t.id(), closed.version(), TicketStatus.OPEN, null);
        assertEquals(1, reopened.state().reopenCount); assertEquals(plumber.membership(), reopened.assignee(), "reopened: back in the queue, and the free plumber takes it");
        assertThrows(DomainException.class, () -> svc().changeStatus(owner, t.id(), reopened.version(), TicketStatus.CANCELLED, " "), "a reason");
        Ticket cancelled = svc().changeStatus(owner, t.id(), reopened.version(), TicketStatus.CANCELLED, "fixed it myself");
        assertEquals("fixed it myself", cancelled.state().cancelReason);
        assertThrows(DomainException.class, () -> svc().changeStatus(treasurer, t.id(), cancelled.version(), TicketStatus.COMPLETED, null), "no such move");
    }

    @Test void aTaskWithMoneyOnItClosesOnlyWhenNothingIsOpen() {
        Ticket t = leak(owner);
        Caller boss = Fixtures.superAdmin();
        Ticket f = svc().edit(boss, t.id(), t.version(), new Ticket.Changes(null, null, null, null, null, null, null, null, null, null, true, null));
        money[0] = position(5000, 1);
        DomainException.RuleViolated open = assertThrows(DomainException.RuleViolated.class, () -> svc().changeStatus(treasurer, t.id(), f.version(), TicketStatus.CLOSED, null));
        assertTrue(open.getMessage().contains("1 release is still waiting"), open.getMessage());
        DomainException.RuleViolated paid = assertThrows(DomainException.RuleViolated.class, () -> svc().changeStatus(treasurer, t.id(), f.version(), TicketStatus.CANCELLED, "x"));
        assertTrue(paid.getMessage().contains("5000"), paid.getMessage());
        money[0] = position(0, 0);
        assertEquals(TicketStatus.CANCELLED, svc().changeStatus(treasurer, t.id(), f.version(), TicketStatus.CANCELLED, "not needed").status());
    }

    @Test void whoEditsWhat() {
        plumberClockedIn = true;
        Ticket t = leak(owner);
        Ticket e = svc().edit(owner, t.id(), t.version(), new Ticket.Changes(null, "Also the tap drips", null, null, null, null, null, null, null, null, null, null));
        assertEquals("Also the tap drips", e.state().description);
        assertThrows(AccessDenied.class, () -> svc().edit(owner, t.id(), e.version(), new Ticket.Changes(null, null, null, null, "Critical", null, null, null, null, null, null, null)), "priority");
        clock = Clock.offset(CLOCK, Duration.ofMinutes(31));
        assertThrows(AccessDenied.class, () -> svc().edit(owner, t.id(), e.version(), new Ticket.Changes(null, "later", null, null, null, null, null, null, null, null, null, null)), "30 minutes");
        Ticket p = svc().edit(plumber, t.id(), e.version(), new Ticket.Changes(null, null, null, null, null, null, null, null, true, Money.of("450"), null, null));
        assertTrue(p.state().awaitingParts); assertEquals(Money.of("450"), p.state().materialsCost);
        assertThrows(AccessDenied.class, () -> svc().edit(plumber, t.id(), p.version(), new Ticket.Changes(null, null, null, null, "Low", null, null, null, null, null, null, null)), "field staff: no priority");
        assertThrows(AccessDenied.class, () -> svc().edit(fm, t.id(), p.version(), new Ticket.Changes(null, null, null, null, null, null, null, LocalDate.of(2026, 12, 1), null, null, null, null)), "SLA: EC only");
        assertThrows(AccessDenied.class, () -> svc().edit(fm, t.id(), p.version(), new Ticket.Changes(null, null, null, null, null, null, null, null, null, null, true, null)), "financial flag");
        Ticket ec = svc().edit(treasurer, t.id(), p.version(), new Ticket.Changes(null, null, null, null, "Critical", null, null, LocalDate.of(2026, 12, 1), null, null, null, null));
        assertEquals("Critical", ec.state().priority);
        Ticket money = svc().edit(treasurer, t.id(), ec.version(), new Ticket.Changes(null, null, null, null, null, null, null, null, null, null, true, null));
        assertTrue(money.state().financial, "the treasurer (a committee member) marks a task financial");
        assertThrows(DomainException.class, () -> svc().edit(treasurer, t.id(), money.version(), new Ticket.Changes(null, null, null, null, null, null, null, LocalDate.of(2020, 1, 1), null, null, null, null)), "past SLA");
    }

    @Test void theCommitteeSignsOffATaskThatMovesNoMoney() {
        Ticket t = svc().raise(fm, new TicketService.RaiseTicket(PURCHASE.id(), "Pool chairs", null, null, "Community", "Pool deck", "General", null, null, null, LocalDate.of(2026, 11, 1)));
        assertThrows(AccessDenied.class, () -> svc().signOff(fm, t.id(), t.version(), "Approved"), "the committee signs off");
        assertThrows(DomainException.class, () -> svc().signOff(treasurer, t.id(), t.version(), "Maybe"), "a known value");
        long first = t.version();
        Ticket ok = svc().signOff(treasurer, t.id(), first, "Approved");
        assertEquals("Approved", ok.state().approval.ecApproval());
        assertThrows(DomainException.Conflict.class, () -> svc().signOff(treasurer, t.id(), first, "Rejected"), "an old version");
        Ticket f = svc().edit(treasurer, t.id(), ok.version(), new Ticket.Changes(null, null, null, null, null, null, null, null, null, null, true, null));
        assertThrows(DomainException.RuleViolated.class, () -> svc().signOff(treasurer, t.id(), f.version(), "Rejected"), "money in it: the quotation is approved instead");
        Ticket r = leak(owner);
        assertThrows(DomainException.RuleViolated.class, () -> svc().signOff(treasurer, r.id(), r.version(), "Approved"), "a resident request asks for no sign-off");
    }

    @Test void whoSeesWhatAndMeToo() {
        Ticket mine = leak(owner);
        Ticket street = svc().raise(neighbour, new TicketService.RaiseTicket(null, "Street light out", null, null, "Community", "Main road near gate 2", "Electrical", null, null, null, null));
        Ticket purchase = svc().raise(treasurer, new TicketService.RaiseTicket(PURCHASE.id(), "New DG battery", null, null, "Community", "DG room", "MEP", null, null, null, null));
        TicketPolicy p = new TicketPolicy();
        assertTrue(p.readScope(owner).matches(mine)); assertTrue(p.readScope(owner).matches(street), "community requests are seen by all residents");
        assertFalse(p.readScope(owner).matches(purchase), "internal work never reaches residents");
        assertFalse(p.readScope(neighbour).matches(mine));
        assertTrue(p.readScope(owner).sql().contains("tt.resident_visible"));
        assertTrue(p.readScope(fm).matches(purchase));
        assertThrows(AccessDenied.NotVisible.class, () -> svc().get(neighbour, mine.id()));
        Ticket joined = svc().meToo(owner, street.id(), null, true);
        assertTrue(joined.state().affectedUnits.contains(UNIT_A));
        assertThrows(AccessDenied.class, () -> svc().meToo(owner, street.id(), UNIT_B, true), "only my own unit");
        assertFalse(svc().meToo(owner, street.id(), null, false).state().affectedUnits.contains(UNIT_A));
    }

    @Test void commentsAndRating() {
        Ticket t = leak(owner);
        svc().comment(fm, t.id(), "Parts ordered", "Internal");
        svc().comment(owner, t.id(), "Please come after 5", "Public");
        assertThrows(AccessDenied.class, () -> svc().comment(owner, t.id(), "psst", "Internal"));
        assertEquals(1, svc().comments(owner, t.id()).size(), "residents do not see internal notes");
        assertEquals(2, svc().comments(fm, t.id()).size());
        assertEquals(1, svc().recentComments(owner, 50).size()); assertEquals(0, svc().recentComments(neighbour, 50).size(), "not on another unit's ticket");
        assertThrows(DomainException.class, () -> svc().rate(owner, t.id(), 5), "rate once done");
        Ticket w = svc().changeStatus(fm, t.id(), t.version(), TicketStatus.IN_PROGRESS, null);
        Ticket d = svc().changeStatus(fm, t.id(), w.version(), TicketStatus.COMPLETED, null);
        assertEquals(5, (int) svc().rate(owner, t.id(), 5).state().residentRating);
        assertThrows(AccessDenied.class, () -> svc().rate(fm, t.id(), 1));
        assertNotNull(d);
    }
}
