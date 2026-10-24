package com.communityos.api.governance;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.comms.application.Recipes;
import com.communityos.api.governance.application.BallotService;
import com.communityos.api.governance.application.GovernancePolicy;
import com.communityos.api.governance.application.MeetingService;
import com.communityos.api.governance.application.VoteService;
import com.communityos.api.governance.application.port.GovernanceStore;
import com.communityos.api.governance.domain.Governance;
import com.communityos.api.identity.application.CodeHasher;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Meetings' rules, the roll fingerprint, the hash chain, the count, and a whole ballot: codes, proofs, one vote per unit, the sealed box. */
class GovernanceTest {
    static final LocalDate TODAY = LocalDate.of(2026, 10, 20);
    static final class MovingClock extends Clock {
        Instant now = Fixtures.CLOCK.instant();
        @Override public ZoneId getZone() { return ZoneId.of("Asia/Kolkata"); }
        @Override public Clock withZone(ZoneId z) { return this; }
        @Override public Instant instant() { return now; }
        void plus(Duration d) { now = now.plus(d); }
    }

    // ---- the domain ----------------------------------------------------------------------------------------------------------------------------
    @Test void ballotShape() {
        Governance.Ballot b = new Governance.Ballot(); b.title = "Repaint the clubhouse"; b.options = List.of(); b.opensOn = TODAY; b.closesOn = TODAY.plusDays(7);
        b.check(); assertEquals(List.of("For", "Against", "Abstain"), b.options, "a resolution without options gets For / Against / Abstain");
        b.options = List.of("For", "For", " Against "); b.check(); assertEquals(List.of("For", "Against"), b.options, "trimmed, no duplicates");
        b.options = List.of("Yes", "No"); assertEquals("bad-options", assertThrows(DomainException.RuleViolated.class, b::check).code());
        b.kind = "Choose one"; b.options = List.of("Blue"); assertEquals("bad-options", assertThrows(DomainException.RuleViolated.class, b::check).code());
        b.options = List.of("Blue", "Green"); b.closesOn = TODAY.minusDays(1); assertEquals("bad-dates", assertThrows(DomainException.RuleViolated.class, b::check).code());
        b.closesOn = TODAY; b.quorumPct = new BigDecimal("101"); assertEquals("bad-pct", assertThrows(DomainException.RuleViolated.class, b::check).code());
        b.quorumPct = BigDecimal.TEN; b.status = "Open";
        assertEquals("Voting opens on " + TODAY.plusDays(1), withOpens(b, TODAY.plusDays(1)).windowWhyNot(TODAY));
        b.opensOn = TODAY; assertEquals("", b.windowWhyNot(TODAY)); assertEquals("The voting window has ended", b.windowWhyNot(TODAY.plusDays(1)));
    }
    static Governance.Ballot withOpens(Governance.Ballot b, LocalDate d) { b.opensOn = d; return b; }

    @Test void rollFingerprintAndChain() {
        UUID p1 = UUID.randomUUID(), p2 = UUID.randomUUID(), u1 = UUID.randomUUID(), u2 = UUID.randomUUID();
        var a = new Governance.Elector(u1, "Villa 1", List.of(new Governance.Owner(UUID.randomUUID(), p1, "Asha", "1234"), new Governance.Owner(UUID.randomUUID(), p2, "Ravi", null)));
        var b = new Governance.Elector(u2, "Villa 2", List.of(new Governance.Owner(UUID.randomUUID(), null, "No sign-in", null)));
        var a2 = new Governance.Elector(u1, "Villa 1", List.of(a.owners().get(1), a.owners().get(0)));
        assertEquals(Governance.rollHash(List.of(a, b)), Governance.rollHash(List.of(b, a2)), "order of units and owners does not matter");
        assertFalse(Governance.rollHash(List.of(a, b)).equals(Governance.rollHash(List.of(a))), "a unit more or less changes it");
        assertTrue(a.mayVote(p1)); assertFalse(b.mayVote(null)); assertFalse(a.mayVote(UUID.randomUUID()));

        Governance.BoxRow r1 = Governance.next(null, 0, "aaaaaaaaaaaa", "For");
        Governance.BoxRow r2 = Governance.next(r1.hash(), 1, "bbbbbbbbbbbb", "Against");
        assertEquals(Governance.GENESIS, r1.prevHash()); assertEquals(2, r2.seq());
        // the same chain the app recomputes: sha256(prev|seq|receipt|choice)
        assertEquals(Governance.sha256Hex(Governance.GENESIS + "|1|aaaaaaaaaaaa|For"), r1.hash());
        assertEquals(new Governance.Chain(true, r2.hash(), 2, 0), Governance.verify(List.of(r2, r1)));
        Governance.BoxRow forged = new Governance.BoxRow(2, r2.receipt(), "For", r2.prevHash(), r2.hash());
        assertEquals(2, Governance.verify(List.of(r1, forged)).brokenAt(), "a changed choice breaks the chain");
        assertEquals(1, Governance.verify(List.of(r2)).brokenAt(), "a removed vote breaks it");
    }

    @Test void count() {
        Governance.Ballot b = new Governance.Ballot(); b.options = List.of("For", "Against", "Abstain"); b.rollSize = 10; b.quorumPct = new BigDecimal("50"); b.passPct = new BigDecimal("50");
        List<Governance.BoxRow> rows = new ArrayList<>();
        for (String c : List.of("For", "For", "For", "Against", "Abstain")) rows.add(new Governance.BoxRow(rows.size() + 1, "r", c, "p", "h"));
        Governance.Tally t = Governance.tally(b, rows);
        assertEquals("Passed", t.outcome()); assertEquals(new BigDecimal("50.0"), t.turnoutPct()); assertEquals(3, (int) t.counts().get("For"));
        assertEquals(List.of("For", "Against", "Abstain"), List.copyOf(t.counts().keySet()), "options in their order");
        assertEquals("No quorum", Governance.tally(b, rows.subList(0, 4)).outcome());
        b.passPct = new BigDecimal("75"); assertEquals("Not passed", Governance.tally(b, rows).outcome(), "3 of 4 is not MORE than 75%");
        b.kind = "Choose one"; b.options = List.of("Blue", "Green"); b.rollSize = 2; b.quorumPct = BigDecimal.ZERO;
        assertEquals("Winner: Blue", Governance.tally(b, List.of(new Governance.BoxRow(1, "r", "Blue", "p", "h"))).outcome());
        assertEquals("Tie / no votes", Governance.tally(b, List.of(new Governance.BoxRow(1, "r", "Blue", "p", "h"), new Governance.BoxRow(2, "r", "Green", "p", "h"))).outcome());
    }

    // ---- meetings --------------------------------------------------------------------------------------------------------------------------------
    @Test void meetings() {
        Store store = new Store(); Fixtures.Outbox outbox = new Fixtures.Outbox(); Fixtures.Audit audit = new Fixtures.Audit();
        MeetingService ms = new MeetingService(store, Fixtures.events(List.of(), outbox), audit, Tx.direct(), Fixtures.CLOCK);
        Caller sec = secretary(), owner = Fixtures.owner(Fixtures.UNIT_A);
        assertThrows(AccessDenied.class, () -> ms.create(owner, fields("AGM", TODAY.plusDays(5), "Scheduled", Governance.INTERNAL, null)));
        Governance.Meeting m = ms.create(sec, fields("AGM", TODAY.plusDays(5), "Scheduled", Governance.INTERNAL, null));
        assertTrue(outbox.events.isEmpty(), "internal: nobody is told");
        assertTrue(ms.list(owner, null, null, null).isEmpty()); assertThrows(AccessDenied.NotVisible.class, () -> ms.get(owner, m.id));
        assertEquals("not-held", assertThrows(DomainException.RuleViolated.class, () -> ms.update(sec, m.id, m.version, fields("AGM", TODAY.plusDays(5), "Completed", Governance.INTERNAL, null))).code());
        assertEquals("not-held", assertThrows(DomainException.RuleViolated.class, () -> ms.update(sec, m.id, m.version, fields("AGM", TODAY.plusDays(5), "Scheduled", Governance.INTERNAL, "<p>Minutes</p>"))).code());
        Governance.Meeting pub = ms.update(sec, m.id, m.version, fields("AGM", TODAY.plusDays(5), "Scheduled", Governance.PUBLISHED, null));
        assertNotNull(pub.publishedAt); assertEquals("governance.meeting.published", outbox.events.get(0).topic());
        var msg = Recipes.of(outbox.events.get(0), null).get(0); assertEquals(Set.of("owner", "resident"), msg.to().roles());
        assertEquals(1, ms.list(owner, null, null, null).size());
        Governance.Meeting moved = ms.update(sec, m.id, pub.version, fields("AGM", TODAY.minusDays(1), "Scheduled", Governance.PUBLISHED, null));
        assertEquals("governance.meeting.changed", outbox.events.get(1).topic());
        Governance.Meeting done = ms.update(sec, m.id, moved.version, fields("AGM", TODAY.minusDays(1), "Completed", Governance.PUBLISHED, "<p>Resolved: repaint.</p>"));
        assertNotNull(done.minutesAt); assertEquals("governance.meeting.minutes", outbox.events.get(2).topic());
        assertEquals("completed", assertThrows(DomainException.RuleViolated.class, () -> ms.update(sec, m.id, done.version, fields("AGM", TODAY.minusDays(1), "Scheduled", Governance.PUBLISHED, "<p>x</p>"))).code());
        assertEquals("keep-meeting", assertThrows(DomainException.RuleViolated.class, () -> ms.delete(sec, m.id, done.version)).code());
        assertThrows(DomainException.Conflict.class, () -> ms.update(sec, m.id, 1, fields("AGM", TODAY, "Completed", Governance.PUBLISHED, null)));
        Governance.Meeting other = ms.create(sec, fields("Landscape", TODAY.plusDays(3), "Scheduled", Governance.INTERNAL, null));
        ms.delete(sec, other.id, other.version); assertTrue(store.meetings.get(other.id) == null, "never published, no minutes: may go");
        var bad = new MeetingService.Fields("x", "EC", TODAY, LocalTime.of(10, 0), LocalTime.of(9, 0), null, null, null, null, null, null);
        assertEquals("bad-time", assertThrows(DomainException.RuleViolated.class, () -> ms.create(sec, bad)).code());
    }
    static MeetingService.Fields fields(String title, LocalDate date, String status, String visibility, String minutes) {
        return new MeetingService.Fields(title, "General body / AGM", date, LocalTime.of(10, 0), LocalTime.of(12, 0), "Clubhouse", status, visibility, "<p>Agenda</p>", minutes, null);
    }

    // ---- a ballot from draft to result ----------------------------------------------------------------------------------------------------------
    @Test void ballot() {
        Store store = new Store(); Fixtures.Outbox outbox = new Fixtures.Outbox(); Fixtures.Audit audit = new Fixtures.Audit(); MovingClock clock = new MovingClock();
        ZoneId zone = ZoneId.of("Asia/Kolkata");
        BallotService bs = new BallotService(store, Fixtures.events(List.of(), outbox), audit, Tx.direct(), clock);
        List<String> sent = new ArrayList<>();
        VoteService vs = new VoteService(store, new CodeHasher("x".repeat(32)), (to, code) -> sent.add(code), false, "+91", audit, Tx.direct(), clock);
        Caller sec = secretary();
        UUID u1 = UUID.randomUUID(), u2 = UUID.randomUUID(), u3 = UUID.randomUUID();
        Caller asha = person(u1), ravi = person(u2), tenant = Fixtures.caller(Caller.Category.Resident, Set.of("resident"), Set.of(), Set.of());
        store.owners.add(new Governance.Elector(u1, "Villa 1", List.of(new Governance.Owner(UUID.randomUUID(), asha.person().value(), "Asha", "1001"))));
        store.owners.add(new Governance.Elector(u2, "Villa 2", List.of(new Governance.Owner(UUID.randomUUID(), ravi.person().value(), "Ravi", "1002"))));
        store.owners.add(new Governance.Elector(u3, "Villa 3", List.of(new Governance.Owner(UUID.randomUUID(), null, "Not signed in", null))));

        Governance.Ballot b = bs.create(sec, new BallotService.Fields("Repaint the clubhouse", null, "Resolution", null, TODAY, TODAY.plusDays(2), new BigDecimal("50"), new BigDecimal("50"), null));
        assertThrows(AccessDenied.NotVisible.class, () -> bs.get(asha, b.id), "drafts are the committee's");
        assertEquals("Voting has not opened yet", bs.get(sec, b.id).whyNotMe());
        BallotService.View open = bs.open(sec, b.id, b.version);
        assertEquals("Open", open.ballot().status); assertEquals(3, open.ballot().rollSize); assertEquals(Governance.rollHash(store.owners), open.ballot().rollHash);
        assertEquals("governance.ballot.opened", outbox.events.get(0).topic());
        store.owners.clear();   // a later change of owners does not touch the frozen roll
        assertEquals("ballot-open", assertThrows(DomainException.RuleViolated.class, () -> bs.update(sec, b.id, open.ballot().version, new BallotService.Fields("x", null, null, null, TODAY, TODAY, null, null, null))).code());
        assertEquals("keep-ballot", assertThrows(DomainException.RuleViolated.class, () -> bs.delete(sec, b.id, open.ballot().version)).code());

        // who may vote
        assertEquals("", bs.get(asha, b.id).whyNotMe()); assertEquals("Villa 1", bs.get(asha, b.id).mine().get(0).unitNo());
        assertTrue(bs.get(tenant, b.id).whyNotMe().startsWith("Only registered owners"));
        assertThrows(AccessDenied.class, () -> vs.requestCode(tenant, b.id, null));
        assertThrows(AccessDenied.class, () -> vs.requestCode(ravi, b.id, u1), "not Ravi's unit");
        assertEquals("no-phone", assertThrows(DomainException.RuleViolated.class, () -> vs.requestCode(asha, b.id, null)).code());
        store.phones.put(u1 + "|" + asha.person().value(), "+919800001001"); store.phones.put(u2 + "|" + ravi.person().value(), "+919800001002");

        // the second factor
        VoteService.Sent s = vs.requestCode(asha, b.id, null);
        assertEquals("1001", s.phoneLast4()); assertNull(s.code(), "the code goes to the phone, never to the screen"); assertEquals(1, sent.size());
        assertEquals("wait", assertThrows(DomainException.RuleViolated.class, () -> vs.requestCode(asha, b.id, null)).code());
        assertEquals("no-proof", assertThrows(DomainException.RuleViolated.class, () -> vs.cast(asha, b.id, null, "made-up", "For")).code());
        String wrong = sent.get(0).equals("000000") ? "111111" : "000000";
        assertEquals("wrong-code", assertThrows(DomainException.RuleViolated.class, () -> vs.verifyCode(asha, b.id, null, wrong)).code());
        assertEquals(1, store.challenges.values().iterator().next().attempts(), "a wrong try is counted");
        String proof = vs.verifyCode(asha, b.id, null, sent.get(0));
        assertEquals("bad-choice", assertThrows(DomainException.RuleViolated.class, () -> vs.cast(asha, b.id, null, proof, "Maybe")).code());
        VoteService.Receipt r1 = vs.cast(asha, b.id, null, proof, "For");
        assertEquals(1, r1.seq()); assertTrue(r1.receipt().matches("[0-9a-f]{12}"));
        assertEquals("voted", assertThrows(DomainException.RuleViolated.class, () -> vs.requestCode(asha, b.id, null)).code(), "one vote per unit");
        assertTrue(audit.lines.stream().noneMatch((l) -> l.contains("For")), "the audit trail never holds the choice");
        assertTrue(store.boxRows.stream().allMatch((x) -> x.receipt().equals(r1.receipt())), "the box row has a receipt, no unit or person");

        // three wrong tries and the code is gone; a proof is good once
        clock.plus(Duration.ofSeconds(31));
        vs.requestCode(ravi, b.id, u2);
        for (int i = 0; i < 2; i++) assertEquals("wrong-code", assertThrows(DomainException.RuleViolated.class, () -> vs.verifyCode(ravi, b.id, u2, wrongFor(sent))).code());
        assertEquals("tries", assertThrows(DomainException.RuleViolated.class, () -> vs.verifyCode(ravi, b.id, u2, wrongFor(sent))).code());
        assertEquals("no-code", assertThrows(DomainException.RuleViolated.class, () -> vs.verifyCode(ravi, b.id, u2, last(sent))).code());
        clock.plus(Duration.ofSeconds(31));
        vs.requestCode(ravi, b.id, u2);
        String p2 = vs.verifyCode(ravi, b.id, u2, last(sent));
        clock.plus(Duration.ofMinutes(3));
        assertEquals("no-proof", assertThrows(DomainException.RuleViolated.class, () -> vs.cast(ravi, b.id, u2, p2, "Against")).code(), "the proof works for 2 minutes");
        clock.plus(Duration.ofSeconds(31));
        vs.requestCode(ravi, b.id, u2);
        VoteService.Receipt r2 = vs.cast(ravi, b.id, u2, vs.verifyCode(ravi, b.id, u2, last(sent)), "Against");
        assertEquals(2, r2.seq());

        // sealed until closed, closed from the closing day (or when everyone voted)
        assertEquals("sealed", assertThrows(DomainException.RuleViolated.class, () -> bs.box(sec, b.id)).code());
        assertNull(bs.get(sec, b.id).tally());
        assertEquals("still-open", assertThrows(DomainException.RuleViolated.class, () -> bs.close(sec, b.id, store.ballots.get(b.id).version)).code());
        var roll = bs.roll(asha, b.id);
        assertEquals(3, roll.size()); assertEquals(List.of("Asha"), roll.get(0).owners()); assertEquals(List.of(), roll.get(1).owners(), "other units' owners are not shown");
        assertTrue(roll.get(1).voted()); assertNull(roll.get(1).votedBy()); assertEquals(ravi.displayName(), bs.roll(sec, b.id).get(1).votedBy());
        clock.plus(Duration.ofDays(2));
        BallotService.View closed = bs.close(sec, b.id, store.ballots.get(b.id).version);
        assertEquals("Closed", closed.ballot().status); assertEquals(2, (int) closed.ballot().votesCounted);
        assertEquals("Not passed", closed.tally().outcome(), "1 For, 1 Against is not more than 50%"); assertTrue(closed.tally().quorumMet(), "2 of 3 units");
        assertTrue(closed.chain().ok());
        BallotService.Box box = bs.box(asha, b.id); assertTrue(box.matchesClose()); assertEquals(2, box.rows().size());
        assertEquals("governance.ballot.closed", outbox.events.get(1).topic());
        assertEquals(Set.of("owner"), Recipes.of(outbox.events.get(1), null).get(0).to().roles());

        // a tampered box is refused at close
        Governance.Ballot b2 = bs.create(sec, new BallotService.Fields("Second", null, "Choose one", List.of("Blue", "Green"), TODAY.plusDays(2), TODAY.plusDays(2), BigDecimal.ZERO, null, null));
        store.owners.add(new Governance.Elector(u1, "Villa 1", List.of(new Governance.Owner(UUID.randomUUID(), asha.person().value(), "Asha", "1001"))));
        bs.open(sec, b2.id, b2.version);
        clock.plus(Duration.ofSeconds(31));
        vs.requestCode(asha, b2.id, u1);
        vs.cast(asha, b2.id, u1, vs.verifyCode(asha, b2.id, u1, last(sent)), "Blue");
        int i = store.boxRows.size() - 1; Governance.BoxRow x = store.boxRows.get(i);
        store.boxRows.set(i, new Governance.BoxRow(x.seq(), x.receipt(), "Green", x.prevHash(), x.hash()));
        assertEquals("box-broken", assertThrows(DomainException.RuleViolated.class, () -> bs.close(sec, b2.id, store.ballots.get(b2.id).version)).code(), "everyone voted, so it may close early - but not like this");
        assertFalse(GovernancePolicy.manager(asha)); assertTrue(GovernancePolicy.manager(sec));
    }
    static String last(List<String> sent) { return sent.get(sent.size() - 1); }
    static String wrongFor(List<String> sent) { return last(sent).equals("000000") ? "111111" : "000000"; }
    static Caller secretary() { return Fixtures.caller(Caller.Category.EC, Set.of("general_secretary"), Set.of(), Set.of(), Permission.MANAGE_GOVERNANCE); }
    static Caller person(UUID unit) {
        return new Caller(new PersonId(UUID.randomUUID()), new MembershipId(UUID.randomUUID()), Fixtures.COMMUNITY, "Owner of " + unit, Caller.Category.Resident, Set.of("owner"), Set.of(),
            Set.of(new com.communityos.api.shared.domain.Ids.UnitId(unit)), Set.of(), null, Set.of());
    }

    /** The store in memory, with the database's own refusals (a sealed box, one mark per unit). */
    static final class Store implements GovernanceStore {
        final Map<UUID, Governance.Meeting> meetings = new LinkedHashMap<>();
        final Map<UUID, Governance.Ballot> ballots = new LinkedHashMap<>();
        final List<Governance.Elector> owners = new ArrayList<>();
        final Map<UUID, List<Governance.Elector>> rolls = new LinkedHashMap<>();
        final List<Mark> markRows = new ArrayList<>();
        final List<Governance.BoxRow> boxRows = new ArrayList<>(); final List<UUID> boxBallot = new ArrayList<>();
        final Map<String, Challenge> challenges = new LinkedHashMap<>();
        final Map<String, String> phones = new LinkedHashMap<>();
        int n = 0;
        @Override public List<Governance.Meeting> meetings(MeetingFilter f) { return meetings.values().stream().filter((m) -> !f.publishedOnly() || m.published()).toList(); }
        @Override public Optional<Governance.Meeting> meeting(UUID id, boolean lock) { return Optional.ofNullable(meetings.get(id)).map(GovernanceTest::copy); }
        @Override public void insert(Governance.Meeting m) { if (m.id == null) m.id = UUID.randomUUID(); m.version = 1; m.shortId = "MTG-" + (++n); meetings.put(m.id, copy(m)); }
        @Override public boolean update(Governance.Meeting m) { Governance.Meeting o = meetings.get(m.id); if (o == null || o.version != m.version) return false; m.version++; meetings.put(m.id, copy(m)); return true; }
        @Override public boolean deleteMeeting(UUID id, long version) { return meetings.remove(id) != null; }
        @Override public List<Governance.Ballot> ballots(boolean withDrafts) { return ballots.values().stream().filter((b) -> withDrafts || !b.draft()).map(this::sized).toList(); }
        @Override public Optional<Governance.Ballot> ballot(UUID id, boolean lock) { return Optional.ofNullable(ballots.get(id)).map(this::sized); }
        Governance.Ballot sized(Governance.Ballot b) { Governance.Ballot c = copy(b); c.rollSize = rolls.getOrDefault(b.id, List.of()).size(); return c; }
        @Override public void insert(Governance.Ballot b) { b.id = UUID.randomUUID(); b.version = 1; b.shortId = "BAL-" + (++n); ballots.put(b.id, copy(b)); }
        @Override public boolean updateDraft(Governance.Ballot b) { return save(b); }
        boolean save(Governance.Ballot b) { Governance.Ballot o = ballots.get(b.id); if (o == null || o.version != b.version) return false; b.version++; ballots.put(b.id, copy(b)); return true; }
        @Override public boolean deleteBallot(UUID id, long version) { return ballots.remove(id) != null; }
        @Override public List<Governance.Elector> currentOwners() { return List.copyOf(owners); }
        @Override public List<Voters> voters() { return List.of(); }
        @Override public java.util.Optional<String> setVoter(UUID unit, UUID occupant) { return java.util.Optional.empty(); }
        @Override public boolean open(Governance.Ballot b, List<Governance.Elector> roll) { if (!save(b)) return false; rolls.put(b.id, List.copyOf(roll)); return true; }
        @Override public List<Governance.Elector> roll(UUID ballotId) { return rolls.getOrDefault(ballotId, List.of()); }
        @Override public Optional<Governance.Elector> elector(UUID ballotId, UUID unitId) { return roll(ballotId).stream().filter((e) -> e.unitId().equals(unitId)).findFirst(); }
        @Override public List<MyUnit> unitsOf(UUID personId) {
            List<MyUnit> out = new ArrayList<>();
            rolls.forEach((bid, r) -> r.stream().filter((e) -> e.mayVote(personId)).forEach((e) -> out.add(new MyUnit(bid, e.unitId(), e.unitNo(), voted(bid, e.unitId())))));
            return out;
        }
        @Override public List<Mark> marks(UUID ballotId) { return markRows.stream().filter((m) -> m.ballotId().equals(ballotId)).toList(); }
        @Override public boolean voted(UUID ballotId, UUID unitId) { return markRows.stream().anyMatch((m) -> m.ballotId().equals(ballotId) && m.unitId().equals(unitId)); }
        @Override public void cast(Governance.Ballot b, Mark mark, Governance.BoxRow row) {
            if (voted(b.id, mark.unitId())) throw new IllegalStateException("unique violation");
            markRows.add(mark); boxRows.add(row); boxBallot.add(b.id);
            b.votesCast = row.seq(); b.chainHead = row.hash();
            if (!save(b)) throw new DomainException.Conflict("The ballot");
        }
        @Override public boolean close(Governance.Ballot b) { return save(b); }
        @Override public List<Governance.BoxRow> box(UUID ballotId) {
            if (!ballots.get(ballotId).closed()) return List.of();   // the row policy: nothing before the close
            List<Governance.BoxRow> out = new ArrayList<>();
            for (int i = 0; i < boxRows.size(); i++) if (boxBallot.get(i).equals(ballotId)) out.add(boxRows.get(i));
            return out;
        }
        static String key(UUID b, UUID u, UUID p) { return b + "|" + u + "|" + p; }
        @Override public Optional<Challenge> challenge(UUID ballotId, UUID unitId, UUID personId) { return Optional.ofNullable(challenges.get(key(ballotId, unitId, personId))); }
        @Override public void newChallenge(Challenge c) { challenges.put(key(c.ballotId(), c.unitId(), c.personId()), c); }
        @Override public void updateChallenge(Challenge c) { challenges.put(key(c.ballotId(), c.unitId(), c.personId()), c); }
        @Override public void deleteChallenge(UUID id) { challenges.values().removeIf((c) -> c.id().equals(id)); }
        @Override public String phoneOf(UUID unitId, UUID personId) { return phones.get(unitId + "|" + personId); }
    }
    static Governance.Meeting copy(Governance.Meeting m) {
        Governance.Meeting o = new Governance.Meeting();
        o.id = m.id; o.shortId = m.shortId; o.title = m.title; o.committee = m.committee; o.date = m.date; o.startTime = m.startTime; o.endTime = m.endTime; o.location = m.location;
        o.status = m.status; o.visibility = m.visibility; o.publishedAt = m.publishedAt; o.publishedById = m.publishedById; o.agenda = m.agenda; o.minutes = m.minutes;
        o.minutesAt = m.minutesAt; o.minutesById = m.minutesById; o.cancelReason = m.cancelReason; o.version = m.version;
        return o;
    }
    static Governance.Ballot copy(Governance.Ballot b) {
        Governance.Ballot o = new Governance.Ballot();
        o.id = b.id; o.shortId = b.shortId; o.title = b.title; o.description = b.description; o.kind = b.kind; o.options = b.options; o.opensOn = b.opensOn; o.closesOn = b.closesOn;
        o.quorumPct = b.quorumPct; o.passPct = b.passPct; o.status = b.status; o.rollHash = b.rollHash; o.openedAt = b.openedAt; o.openedById = b.openedById; o.closedAt = b.closedAt;
        o.closedById = b.closedById; o.chainHead = b.chainHead; o.votesCast = b.votesCast; o.votesCounted = b.votesCounted; o.meetingId = b.meetingId; o.rollSize = b.rollSize; o.version = b.version;
        return o;
    }
}
