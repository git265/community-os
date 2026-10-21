package com.communityos.api.governance.application;

import com.communityos.api.governance.application.port.GovernanceStore;
import com.communityos.api.governance.domain.Governance;
import com.communityos.api.governance.domain.Governance.Ballot;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Ballots for registered owners. A draft is edited freely by the committee. Opening freezes the electorate (the units with a registered owner
 * that day, and those owners) and fingerprints it; from then on nothing about the question, options, dates or voters can change - the
 * database refuses it too. It can be closed from its closing day (or once every unit has voted): the box is checked against its hash chain
 * and the count the ballot kept, and only then is it readable, by everyone.
 */
public final class BallotService {
    public record Fields(String title, String description, String kind, List<String> options, LocalDate opensOn, LocalDate closesOn, BigDecimal quorumPct, BigDecimal passPct, UUID meetingId) {}
    public record BallotEvent(String topic, UUID aggregateId, CommunityId communityId, String title, String detail, Instant occurredAt) implements DomainEvent {}
    /** A unit the caller may vote for on this ballot, and why not (if not). */
    public record MyUnit(UUID unitId, String unitNo, boolean voted, String whyNot) {}
    public record View(Ballot ballot, List<MyUnit> mine, String whyNotMe, Governance.Tally tally, Governance.Chain chain) {}
    public record RollEntry(UUID unitId, String unitNo, List<String> owners, String phoneLast4, boolean voted, LocalDate markedOn, String votedBy) {}
    public record Box(List<Governance.BoxRow> rows, Governance.Chain chain, boolean matchesClose) {}

    static final String NOT_OWNER = "Only registered owners can vote (tenants and other residents are not on the owners’ roll)";

    private final GovernanceStore store; private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public BallotService(GovernanceStore store, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }
    LocalDate today() { return LocalDate.now(clock); }

    public List<View> list(Caller c) {
        if (!GovernancePolicy.member(c)) throw new AccessDenied("Members only");
        List<Ballot> all = store.ballots(GovernancePolicy.insider(c));
        Map<UUID, List<GovernanceStore.MyUnit>> mine = c.person() == null ? Map.of() : store.unitsOf(c.person().value()).stream().collect(Collectors.groupingBy(GovernanceStore.MyUnit::ballotId));
        return all.stream().map((b) -> view(b, mine.getOrDefault(b.id, List.of()), false)).toList();
    }
    public View get(Caller c, UUID id) {
        Ballot b = visible(c, id);
        List<GovernanceStore.MyUnit> mine = c.person() == null ? List.of() : store.unitsOf(c.person().value()).stream().filter((u) -> u.ballotId().equals(id)).toList();
        return view(b, mine, true);
    }
    View view(Ballot b, List<GovernanceStore.MyUnit> mine, boolean withChain) {
        String window = b.windowWhyNot(today());
        List<MyUnit> units = mine.stream().map((u) -> new MyUnit(u.unitId(), u.unitNo(), u.voted(), u.voted() ? u.unitNo() + " has already voted on this ballot — one vote per unit" : window)).toList();
        String why = b.draft() ? "Voting has not opened yet" : units.isEmpty() ? (b.closed() ? "Voting is closed" : NOT_OWNER)
            : units.stream().filter((u) -> u.whyNot().isEmpty()).findFirst().map((u) -> "").orElse(units.get(0).whyNot());
        Governance.Tally tally = null; Governance.Chain chain = null;
        if (b.closed()) {
            List<Governance.BoxRow> rows = store.box(b.id);
            tally = Governance.tally(b, rows);
            if (withChain) chain = Governance.verify(rows);
        }
        return new View(b, units, why, tally, chain);
    }
    Ballot visible(Caller c, UUID id) {
        if (!GovernancePolicy.member(c)) throw new AccessDenied.NotVisible();
        Ballot b = store.ballot(id, false).orElseThrow(AccessDenied.NotVisible::new);
        if (b.draft() && !GovernancePolicy.insider(c)) throw new AccessDenied.NotVisible();
        return b;
    }

    public Ballot create(Caller c, Fields f) {
        manager(c);
        return tx.inTx(() -> {
            Ballot b = new Ballot();
            copy(f, b);
            b.check();
            store.insert(b);
            audit.write(c, AuditWriter.Action.Create, "governance.ballot", b.id, b.shortId, null, "Ballot drafted: " + b.title, List.of());
            return b;
        });
    }
    public Ballot update(Caller c, UUID id, long version, Fields f) {
        manager(c);
        return tx.inTx(() -> {
            Ballot b = locked(id, version);
            if (!b.draft()) throw new DomainException.RuleViolated(b.open() ? "ballot-open" : "ballot-closed", b.open() ? "An open ballot cannot be edited" : "A closed ballot can never be changed");
            copy(f, b);
            b.check();
            if (!store.updateDraft(b)) throw new DomainException.Conflict("The ballot");
            audit.write(c, AuditWriter.Action.Update, "governance.ballot", b.id, b.shortId, null, "Ballot draft edited: " + b.title, List.of());
            return b;
        });
    }
    public void delete(Caller c, UUID id, long version) {
        manager(c);
        tx.run(() -> {
            Ballot b = locked(id, version);
            if (!b.draft()) throw new DomainException.RuleViolated("keep-ballot", "Only a draft can be deleted - a ballot that was opened stays on record");
            if (!store.deleteBallot(id, version)) throw new DomainException.Conflict("The ballot");
            audit.write(c, AuditWriter.Action.Delete, "governance.ballot", b.id, b.shortId, null, "Ballot draft deleted: " + b.title, List.of());
        });
    }

    /** Freeze the roll and open voting. */
    public View open(Caller c, UUID id, long version) {
        manager(c);
        Ballot opened = tx.inTx(() -> {
            Ballot b = locked(id, version);
            if (!b.draft()) throw new DomainException.RuleViolated("not-draft", b.open() ? "Voting is already open" : "A closed ballot can never be opened again");
            b.check();
            if (b.closesOn.isBefore(today())) throw new DomainException.RuleViolated("bad-dates", "The closing date has passed - change it before opening voting");
            List<Governance.Elector> roll = store.currentOwners();
            if (roll.isEmpty()) throw new DomainException.RuleViolated("empty-roll", "No unit has a registered owner, so nobody could vote");
            b.rollHash = Governance.rollHash(roll); b.status = "Open"; b.openedAt = clock.instant(); b.openedById = c.membership().value(); b.rollSize = roll.size();
            if (!store.open(b, roll)) throw new DomainException.Conflict("The ballot");
            audit.write(c, AuditWriter.Action.Update, "governance.ballot", b.id, b.shortId, null, "Voting opened on " + b.title + " · " + roll.size() + " units on the roll · roll " + b.rollHash.substring(0, 12), List.of());
            events.publish(List.of(new BallotEvent("governance.ballot.opened", b.id, c.community(), b.title,
                "One vote per unit" + (b.opensOn.isAfter(today()) ? ", from " + b.opensOn : "") + ". Voting closes on " + b.closesOn + ".", clock.instant())));
            return b;
        });
        return get(c, opened.id);
    }

    /** Close voting: from the closing day, or earlier once every unit on the roll has voted. The box must pass its checks. */
    public View close(Caller c, UUID id, long version) {
        manager(c);
        Ballot closed = tx.inTx(() -> {
            Ballot b = locked(id, version);
            if (!b.open()) throw new DomainException.RuleViolated("not-open", b.draft() ? "A ballot must be opened before it is closed" : "Voting is already closed");
            if (today().isBefore(b.closesOn) && b.votesCast < b.rollSize) throw new DomainException.RuleViolated("still-open", "Voting stays open until " + b.closesOn);
            int marks = store.marks(b.id).size();
            b.status = "Closed"; b.closedAt = clock.instant(); b.closedById = c.membership().value(); b.votesCounted = b.votesCast;
            if (!store.close(b)) throw new DomainException.Conflict("The ballot");
            List<Governance.BoxRow> rows = store.box(b.id);
            Governance.Chain chain = Governance.verify(rows);
            String head = b.votesCast == 0 ? Governance.GENESIS : b.chainHead;
            if (!chain.ok()) throw new DomainException.RuleViolated("box-broken", "The ballot box failed its integrity check at vote " + chain.brokenAt() + "; it cannot be closed normally");
            if (chain.count() != b.votesCast || !chain.head().equals(head) || marks != b.votesCast)
                throw new DomainException.RuleViolated("box-broken", "The ballot box does not match the count kept while voting (" + chain.count() + " in the box, " + b.votesCast + " counted, " + marks + " units marked)");
            Governance.Tally t = Governance.tally(b, rows);
            audit.write(c, AuditWriter.Action.Update, "governance.ballot", b.id, b.shortId, null, "Voting closed on " + b.title + " · " + t.cast() + " of " + t.rollSize() + " voted · " + t.outcome(), List.of());
            events.publish(List.of(new BallotEvent("governance.ballot.closed", b.id, c.community(), b.title, t.outcome() + " · " + t.cast() + " of " + t.rollSize() + " units voted.", clock.instant())));
            return b;
        });
        return get(c, closed.id);
    }

    /** The frozen roll: every unit and whether it voted; owner names and who voted only for the managers (and a unit's own people). */
    public List<RollEntry> roll(Caller c, UUID id) {
        Ballot b = visible(c, id);
        if (b.draft()) return List.of();
        Map<UUID, GovernanceStore.Mark> marks = store.marks(b.id).stream().collect(Collectors.toMap(GovernanceStore.Mark::unitId, (m) -> m));
        Set<UUID> own = c.units().stream().map((u) -> u.value()).collect(Collectors.toSet());
        UUID me = c.person() == null ? null : c.person().value();
        boolean all = GovernancePolicy.seesVoters(c);
        return store.roll(b.id).stream().map((e) -> {
            boolean mine = own.contains(e.unitId()) || e.mayVote(me);
            GovernanceStore.Mark m = marks.get(e.unitId());
            String last4 = e.owners().stream().filter((o) -> me != null && me.equals(o.personId())).map(Governance.Owner::phoneLast4).findFirst().orElse(null);
            return new RollEntry(e.unitId(), e.unitNo(), all || mine ? e.owners().stream().map(Governance.Owner::name).toList() : List.of(), last4, m != null, m == null ? null : m.markedOn(),
                m != null && (all || mine) ? m.voter() : null);
        }).toList();
    }

    /** The box, once closed: every vote with its receipt and fingerprint, and whether the chain holds and ends where the close recorded. */
    public Box box(Caller c, UUID id) {
        Ballot b = visible(c, id);
        if (!b.closed()) throw new DomainException.RuleViolated("sealed", "Votes stay sealed (even from administrators) until voting closes");
        List<Governance.BoxRow> rows = store.box(b.id);
        Governance.Chain chain = Governance.verify(rows);
        return new Box(rows, chain, chain.ok() && chain.head().equals(b.votesCast == 0 ? Governance.GENESIS : b.chainHead) && chain.count() == b.votesCounted);
    }

    Ballot locked(UUID id, long version) {
        Ballot b = store.ballot(id, true).orElseThrow(() -> new DomainException.NotFound("Ballot"));
        if (b.version != version) throw new DomainException.Conflict("The ballot");
        return b;
    }
    static void copy(Fields f, Ballot b) {
        b.title = f.title() == null ? null : f.title().strip(); b.description = f.description(); b.kind = f.kind() == null ? "Resolution" : f.kind();
        b.options = f.options() == null ? List.of() : f.options(); b.opensOn = f.opensOn(); b.closesOn = f.closesOn(); b.quorumPct = f.quorumPct(); b.passPct = f.passPct(); b.meetingId = f.meetingId();
    }
    static void manager(Caller c) { if (!GovernancePolicy.manager(c)) throw new AccessDenied("Only the committee runs ballots"); }
}
