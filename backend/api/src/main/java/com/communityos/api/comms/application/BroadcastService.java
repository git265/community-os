package com.communityos.api.comms.application;

import com.communityos.api.comms.application.port.CommsStore;
import com.communityos.api.comms.application.port.Inbox;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.UUID;

/**
 * Notices (broadcasts): the committee writes a draft, sends it now or at a set time; the server works out who it reaches (a receipt per
 * person) and puts it in their inbox. A reader opens it (viewed), signs it when asked, and answers its poll - once per unit, changeable
 * until the poll closes. Counts come from the receipts; a sent notice is never edited, except a maintenance window being moved (and everyone
 * it reached is told).
 */
public final class BroadcastService {
    public record CommsEvent(String topic, UUID aggregateId, CommunityId communityId, String kind, Instant occurredAt) implements DomainEvent {}
    /** What the committee may write on a notice (counts, receipts, status and sender are the server's). */
    public record Draft(String type, String audience, String subject, String message, List<UUID> unitIds, List<UUID> blockIds, LocalDate eventDate, String startTime,
                        String endTime, String affects, List<String> pollOptions, Boolean pollMultiple, LocalDate pollClosesOn, Boolean requiresSignature, String reminderFrequency) {}
    public record Voter(String name, String unitNo, List<String> choices) {}

    private final CommsStore store; private final Inbox inbox; private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    private final ZoneId zone;
    public BroadcastService(CommsStore store, Inbox inbox, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, ZoneId zone) {
        this.store = store; this.inbox = inbox; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock; this.zone = zone;
    }

    /** Publishers see every notice; everyone else the sent notices that reached them. */
    public static Spec<Comms.Broadcast> scope(Caller c) {
        if (CommsPolicy.publisher(c)) return Spec.all();
        if (c.membership() == null) return Spec.none();
        return new Spec<>("b.status = 'Sent' AND me.membership_id IS NOT NULL", java.util.Map.of(), (b) -> b.sent());
    }
    public List<Comms.Broadcast> list(Caller c, String status) { return store.broadcasts(scope(c), reader(c), status).stream().map((b) -> redact(c, b)).toList(); }
    public Comms.Broadcast get(Caller c, UUID id) { return redact(c, find(c, id)); }
    public int reach(Caller c, Draft d) {
        requirePublisher(c);
        Comms.Broadcast b = apply(new Comms.Broadcast(), d); b.check();
        return store.reach(b.reach());
    }

    public Comms.Broadcast create(Caller c, Draft d, boolean sendNow, Instant scheduleFor) {
        requirePublisher(c);
        return tx.inTx(() -> {
            Comms.Broadcast b = apply(new Comms.Broadcast(), d);
            b.check();
            if (scheduleFor != null) { future(scheduleFor); b.status = "Scheduled"; b.scheduledFor = scheduleFor; }
            store.insert(b);
            audit.write(c, AuditWriter.Action.Create, "comms.broadcast", b.id, b.shortId, null, b.type + ": " + b.subject, List.of());
            if (sendNow) return deliver(c, b);
            return find(c, b.id);
        });
    }
    public Comms.Broadcast update(Caller c, UUID id, long version, Draft d) {
        requirePublisher(c);
        return tx.inTx(() -> {
            Comms.Broadcast b = current(c, id, version);
            if (b.sent()) throw new DomainException.RuleViolated("sent", "A sent notice is not edited - send a correction, or move the maintenance window");
            apply(b, d); b.check();
            save(b);
            audit.write(c, AuditWriter.Action.Update, "comms.broadcast", b.id, b.shortId, null, "Draft changed", List.of());
            return find(c, id);
        });
    }
    public Comms.Broadcast send(Caller c, UUID id, long version) {
        requirePublisher(c);
        return tx.inTx(() -> {
            Comms.Broadcast b = current(c, id, version);
            if (b.sent()) throw new DomainException.RuleViolated("sent", "This notice was already sent");
            return deliver(c, b);
        });
    }
    public Comms.Broadcast schedule(Caller c, UUID id, long version, Instant at) {
        requirePublisher(c);
        return tx.inTx(() -> {
            Comms.Broadcast b = current(c, id, version);
            if (b.sent()) throw new DomainException.RuleViolated("sent", "This notice was already sent");
            if (at == null) { b.status = "Draft"; b.scheduledFor = null; } else { future(at); b.status = "Scheduled"; b.scheduledFor = at; }
            save(b);
            audit.write(c, AuditWriter.Action.Update, "comms.broadcast", b.id, b.shortId, null, at == null ? "Schedule removed" : "Scheduled for " + at, List.of());
            return find(c, id);
        });
    }
    /** Move a sent maintenance window; everyone it reached hears about the new time. */
    public Comms.Broadcast reschedule(Caller c, UUID id, long version, LocalDate date, String start, String end) {
        requirePublisher(c);
        return tx.inTx(() -> {
            Comms.Broadcast b = current(c, id, version);
            if (!"Scheduled maintenance".equals(b.type)) throw new DomainException.RuleViolated("not-maintenance", "Only a maintenance notice has a time to move");
            b.eventDate = date; b.startTime = start; b.endTime = end == null || end.isBlank() ? null : end;
            b.check();
            save(b);
            if (b.sent()) inbox.deliver(new Comms.Message("announcement", "broadcast", "RESCHEDULED - " + b.subject + " (" + when(b) + ")",
                "The maintenance time has changed. Please note the new schedule.", "#/communications", b.id, new Comms.To(new HashSet<>(store.recipients(b.id)), java.util.Set.of(), java.util.Set.of())));
            audit.write(c, AuditWriter.Action.Update, "comms.broadcast", b.id, b.shortId, null, "Maintenance moved to " + when(b), List.of());
            return find(c, id);
        });
    }
    public void remove(Caller c, UUID id, long version) {
        requirePublisher(c);
        tx.run(() -> {
            Comms.Broadcast b = current(c, id, version);
            if (b.sent()) throw new DomainException.RuleViolated("sent", "A sent notice stays on record");
            if (!store.delete(id, version)) throw new DomainException.Conflict("Notice " + b.shortId);
            audit.write(c, AuditWriter.Action.Delete, "comms.broadcast", b.id, b.shortId, null, b.subject, List.of());
        });
    }

    // ---- the reader ----------------------------------------------------------------------------------------------------------------------------
    public Comms.Broadcast view(Caller c, UUID id) {
        return tx.inTx(() -> { Comms.Broadcast b = find(c, id); if (c.membership() != null) store.viewed(id, c.membership().value(), clock.instant()); return redact(c, find(c, b.id)); });
    }
    public Comms.Broadcast sign(Caller c, UUID id) {
        return tx.inTx(() -> {
            Comms.Broadcast b = find(c, id);
            if (!b.requiresSignature) throw new DomainException.RuleViolated("no-signature", "This notice does not ask for a signature");
            if (c.membership() == null || !store.signed(id, c.membership().value(), clock.instant())) throw new AccessDenied("This notice was not sent to you");
            audit.write(c, AuditWriter.Action.Update, "comms.broadcast", b.id, b.shortId, null, "Signed", List.of());
            return redact(c, find(c, id));
        });
    }
    /** Answer (or change the answer to) a notice's poll. One answer per unit: anyone in the household may change it. */
    public Comms.PollResult vote(Caller c, UUID id, List<String> choices, UUID unitId) {
        if (!CommsPolicy.member(c)) throw new AccessDenied("Only members answer polls");
        return tx.inTx(() -> {
            Comms.Broadcast b = find(c, id);
            if (!store.recipients(id).contains(c.membership().value()))
                throw new AccessDenied("This poll was not sent to you");
            List<String> picked = b.choices(choices, LocalDate.now(clock.withZone(zone)));
            UUID unit = unitOf(c, unitId);
            var existing = store.voteOf(id, null, c.membership().value(), unit);
            store.vote(id, null, c.membership().value(), unit, picked, existing.orElse(null));
            store.viewed(id, c.membership().value(), clock.instant());
            return results(c, b);
        });
    }
    public Comms.PollResult results(Caller c, UUID id) { return results(c, find(c, id)); }
    /** Every sent poll the caller can see, with its results (and, for the committee, who voted what) - one call for the polls page. */
    public record PollView(Comms.PollResult results, List<Voter> voters) {}
    public java.util.Map<UUID, PollView> polls(Caller c) {
        boolean publisher = CommsPolicy.publisher(c);
        java.util.Map<UUID, PollView> out = new java.util.LinkedHashMap<>();
        for (Comms.Broadcast b : list(c, "Sent")) if ("Poll".equals(b.type))
            out.put(b.id, new PollView(results(c, b.id), publisher ? store.votes(b.id, null).stream().map((v) -> new Voter(v.voterName(), v.unitNo(), v.choices())).toList() : null));
        return out;
    }
    /** Who voted what - for the committee only. */
    public List<Voter> voters(Caller c, UUID id) {
        requirePublisher(c);
        find(c, id);
        return store.votes(id, null).stream().map((v) -> new Voter(v.voterName(), v.unitNo(), v.choices())).toList();
    }

    // ---- the job -------------------------------------------------------------------------------------------------------------------------------
    /** Send every scheduled notice whose time has come. */
    public int sendDue(Caller system) {
        return tx.inTx(() -> {
            int n = 0;
            for (UUID id : store.due(clock.instant())) {
                Comms.Broadcast b = store.broadcast(id, Spec.all(), null).orElse(null);
                if (b == null || b.sent()) continue;
                deliver(system, b); n++;
            }
            return n;
        });
    }

    // ---- internals -----------------------------------------------------------------------------------------------------------------------------
    private Comms.Broadcast deliver(Caller c, Comms.Broadcast b) {
        b.check();
        int reached = store.deliver(b.id, b.reach());
        b.status = "Sent"; b.sentAt = clock.instant(); b.sentById = c.membership() == null ? null : c.membership().value(); b.recipients = reached; b.scheduledFor = null;
        save(b);
        List<UUID> who = store.recipients(b.id);
        if (!who.isEmpty()) inbox.deliver(new Comms.Message(b.poll() ? "poll" : "announcement", "broadcast",
            (b.poll() ? "Poll" : b.type) + ": " + b.subject + ("Scheduled maintenance".equals(b.type) ? " (" + when(b) + ")" : ""),
            b.poll() ? "A new poll is open — your vote counts." : "A new message has been posted for you in Communications.", "#/communications", b.id,
            new Comms.To(new HashSet<>(who), java.util.Set.of(), java.util.Set.of())));
        events.publish(List.of(new CommsEvent("comms.broadcast.sent", b.id, c.community(), b.type, clock.instant())));
        audit.write(c, AuditWriter.Action.Update, "comms.broadcast", b.id, b.shortId, null, "Sent to " + reached + " people", List.of());
        return store.broadcast(b.id, Spec.all(), reader(c)).map((x) -> redact(c, x)).orElse(b);
    }
    private Comms.PollResult results(Caller c, Comms.Broadcast b) {
        if (!b.poll()) throw new DomainException.RuleViolated("not-a-poll", "This notice is not a poll");
        var votes = store.votes(b.id, null);
        List<Integer> counts = new ArrayList<>();
        for (int i = 0; i < b.pollOptions.size(); i++) { String k = String.valueOf(i); counts.add((int) votes.stream().filter((v) -> v.choices().contains(k)).count()); }
        UUID unit = c.units().size() == 1 ? c.units().iterator().next().value() : null;
        var mine = c.membership() == null ? java.util.Optional.<CommsStore.Vote>empty()
            : votes.stream().filter((v) -> unit != null ? unit.equals(v.unit()) : v.unit() == null && c.membership().value().equals(v.voter())).findFirst();
        return new Comms.PollResult(counts, votes.size(), mine.map(CommsStore.Vote::choices).orElse(List.of()),
            mine.filter((v) -> !c.membership().value().equals(v.voter())).map(CommsStore.Vote::voterName).orElse(null));
    }
    private UUID unitOf(Caller c, UUID asked) {
        if (asked != null) {
            if (c.units().stream().noneMatch((u) -> u.value().equals(asked))) throw new AccessDenied("Vote for your own unit");
            return asked;
        }
        if (c.units().size() > 1) throw new DomainException.RuleViolated("which-unit", "Say which of your units this vote is for");
        return c.units().isEmpty() ? null : c.units().iterator().next().value();
    }
    private Comms.Broadcast find(Caller c, UUID id) { return store.broadcast(id, scope(c), reader(c)).orElseThrow(AccessDenied.NotVisible::new); }
    private Comms.Broadcast current(Caller c, UUID id, long version) {
        Comms.Broadcast b = find(c, id);
        if (b.version != version) throw new DomainException.Conflict("Notice " + b.shortId);
        return b;
    }
    private void save(Comms.Broadcast b) { if (!store.update(b)) throw new DomainException.Conflict("Notice " + b.shortId); }
    private void future(Instant at) { if (!at.isAfter(clock.instant())) throw new DomainException.RuleViolated("past", "Choose a time in the future"); }
    private static UUID reader(Caller c) { return c.membership() == null ? null : c.membership().value(); }
    private static void requirePublisher(Caller c) { if (!CommsPolicy.publisher(c)) throw new AccessDenied("Only the committee sends notices"); }
    /** Readers do not see who else signed. */
    private static Comms.Broadcast redact(Caller c, Comms.Broadcast b) { if (!CommsPolicy.publisher(c)) b.signedBy = List.of(); return b; }
    static String when(Comms.Broadcast b) { return b.eventDate + " " + b.startTime + (b.endTime == null ? "" : "–" + b.endTime); }
    static Comms.Broadcast apply(Comms.Broadcast b, Draft d) {
        b.type = d.type() == null ? "Announcement" : d.type(); b.audience = d.audience() == null ? "All residents" : d.audience(); b.subject = d.subject() == null ? null : d.subject().strip();
        b.message = d.message(); b.audienceUnits = d.unitIds() == null ? List.of() : List.copyOf(new java.util.LinkedHashSet<>(d.unitIds()));
        b.audienceBlocks = d.blockIds() == null ? List.of() : List.copyOf(new java.util.LinkedHashSet<>(d.blockIds()));
        boolean maint = "Scheduled maintenance".equals(b.type);
        b.eventDate = maint ? d.eventDate() : null; b.startTime = maint ? d.startTime() : null; b.endTime = maint && d.endTime() != null && !d.endTime().isBlank() ? d.endTime() : null;
        b.affects = maint ? d.affects() : null;
        b.pollOptions = d.pollOptions() == null ? List.of() : d.pollOptions(); b.pollMultiple = Boolean.TRUE.equals(d.pollMultiple()); b.pollClosesOn = d.pollClosesOn();
        b.requiresSignature = Boolean.TRUE.equals(d.requiresSignature()); b.reminderFrequency = d.reminderFrequency() == null ? "None" : d.reminderFrequency();
        if (!b.audience.startsWith("Selected villas") && !b.audience.startsWith("Selected apartments")) b.audienceUnits = List.of();
        if (!"Selected blocks".equals(b.audience)) b.audienceBlocks = List.of();
        return b;
    }
}
