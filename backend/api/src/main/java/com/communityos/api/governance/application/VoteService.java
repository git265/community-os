package com.communityos.api.governance.application;

import com.communityos.api.governance.application.port.GovernanceStore;
import com.communityos.api.governance.application.port.GovernanceStore.Challenge;
import com.communityos.api.governance.domain.Governance;
import com.communityos.api.governance.domain.Governance.Ballot;
import com.communityos.api.identity.application.CodeHasher;
import com.communityos.api.identity.application.port.OtpSender;
import com.communityos.api.identity.domain.Phone;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

/**
 * Casting a vote, with two factors: the signed-in owner (factor 1) asks for a 6-digit code sent to the mobile registered for the unit
 * (factor 2: 5 minutes, 3 tries, 30 seconds between codes, kept only as an HMAC); the right code becomes a single-use proof (2 minutes) that the
 * cast demands. The cast writes, in one transaction with the ballot locked, the unit's mark on the roll (who voted) and a box row (what was
 * voted: no unit, no person, no time) chained to the one before; nobody is attributed for the box row and the audit trail never holds the choice.
 */
public final class VoteService {
    static final Duration CODE_TTL = Duration.ofMinutes(5), GAP = Duration.ofSeconds(30), PROOF_TTL = Duration.ofMinutes(2);
    static final int TRIES = 3;
    /** What the voter is told after a code was sent; the code itself only where codes are written to the log (development, never prod). */
    public record Sent(UUID unitId, String unitNo, String phoneLast4, long expiresIn, String code) {}
    public record Receipt(UUID ballotId, int seq, String receipt, String hash) {}

    private final GovernanceStore store; private final CodeHasher hasher; private final OtpSender sender; private final boolean echo; private final String countryCode;
    private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public VoteService(GovernanceStore store, CodeHasher hasher, OtpSender sender, boolean echoCodes, String countryCode, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.hasher = hasher; this.sender = sender; this.echo = echoCodes; this.countryCode = countryCode; this.audit = audit; this.tx = tx; this.clock = clock;
    }
    LocalDate today() { return LocalDate.now(clock); }

    record Voter(Ballot ballot, Governance.Elector elector, UUID person) {}
    /** May this person vote for this unit on this ballot now? The unit may be left out when they own just one unit on the roll. */
    Voter voter(Caller c, UUID ballotId, UUID unitId, boolean lock) {
        if (!GovernancePolicy.member(c) || c.person() == null) throw new AccessDenied("Sign in to vote");
        Ballot b = store.ballot(ballotId, lock).orElseThrow(AccessDenied.NotVisible::new);
        if (b.draft()) throw new DomainException.RuleViolated("not-open", "Voting has not opened yet");
        String window = b.windowWhyNot(today());
        if (!window.isEmpty()) throw new DomainException.RuleViolated("window", window);
        UUID me = c.person().value();
        UUID unit = unitId;
        if (unit == null) {
            List<GovernanceStore.MyUnit> mine = store.unitsOf(me).stream().filter((u) -> u.ballotId().equals(ballotId)).toList();
            if (mine.isEmpty()) throw new AccessDenied(BallotService.NOT_OWNER);
            if (mine.size() > 1) throw new DomainException.RuleViolated("which-unit", "You own more than one unit on this roll - say which unit you are voting for");
            unit = mine.get(0).unitId();
        }
        Governance.Elector e = store.elector(ballotId, unit).orElse(null);
        if (e == null) throw new AccessDenied("That unit is not on this ballot’s voter roll");
        if (!e.mayVote(me)) throw new AccessDenied("Only a registered owner of " + e.unitNo() + " can vote for it");
        if (store.voted(ballotId, unit)) throw new DomainException.RuleViolated("voted", e.unitNo() + " has already voted on this ballot — one vote per unit");
        return new Voter(b, e, me);
    }

    public Sent requestCode(Caller c, UUID ballotId, UUID unitId) {
        Voter v = voter(c, ballotId, unitId, false);
        String phone = store.phoneOf(v.elector().unitId(), v.person());
        if (phone == null) throw new DomainException.RuleViolated("no-phone", "No mobile number is registered for you on the owners’ register. Please ask the office.");
        String code = Crypto.randomDigits(6);
        Instant now = clock.instant();
        tx.run(() -> {
            store.challenge(ballotId, v.elector().unitId(), v.person()).ifPresent((prev) -> {
                if (Duration.between(prev.sentAt(), now).compareTo(GAP) < 0)
                    throw new DomainException.RuleViolated("wait", "Please wait " + (GAP.minus(Duration.between(prev.sentAt(), now)).toSeconds() + 1) + " seconds before asking for another code.");
            });
            UUID id = UUID.randomUUID();
            store.newChallenge(new Challenge(id, ballotId, v.elector().unitId(), v.person(), hasher.hash(id, code), 0, now, now.plus(CODE_TTL), null, null));
        });
        sender.send(Phone.parse(phone, countryCode), code);
        String last4 = phone.length() >= 4 ? phone.substring(phone.length() - 4) : "";
        return new Sent(v.elector().unitId(), v.elector().unitNo(), last4, CODE_TTL.toSeconds(), echo ? code : null);
    }

    private sealed interface Outcome permits Proof, Refused {}
    private record Proof(String token) implements Outcome {}
    private record Refused(String code, String message) implements Outcome {}

    /** Checks the code; a right one becomes the single-use proof. Wrong tries are recorded even though the answer is a refusal. */
    public String verifyCode(Caller c, UUID ballotId, UUID unitId, String code) {
        Voter v = voter(c, ballotId, unitId, false);
        Outcome out = tx.inTx(() -> {
            Instant now = clock.instant();
            Challenge ch = store.challenge(ballotId, v.elector().unitId(), v.person()).orElse(null);
            if (ch == null || ch.codeHash() == null || ch.proofHash() != null) return new Refused("no-code", "Ask for a code first.");
            if (now.isAfter(ch.expiresAt())) { store.deleteChallenge(ch.id()); return new Refused("expired", "That code has expired. Ask for a new one."); }
            if (ch.attempts() >= TRIES) { store.deleteChallenge(ch.id()); return new Refused("tries", "Too many wrong attempts. Ask for a new code."); }
            if (code == null || !code.strip().matches("[0-9]{6}") || !hasher.matches(ch.id(), code.strip(), ch.codeHash())) {
                int tries = ch.attempts() + 1;
                if (tries >= TRIES) { store.deleteChallenge(ch.id()); return new Refused("tries", "That code is not right. Too many wrong attempts - ask for a new code."); }
                store.updateChallenge(new Challenge(ch.id(), ch.ballotId(), ch.unitId(), ch.personId(), ch.codeHash(), tries, ch.sentAt(), ch.expiresAt(), null, null));
                int left = TRIES - tries;
                return new Refused("wrong-code", "That code is not right (" + left + " attempt" + (left == 1 ? "" : "s") + " left).");
            }
            String token = Crypto.randomToken(24);
            store.updateChallenge(new Challenge(ch.id(), ch.ballotId(), ch.unitId(), ch.personId(), ch.codeHash(), ch.attempts() + 1, ch.sentAt(), ch.expiresAt(), Crypto.sha256(token), now.plus(PROOF_TTL)));
            return new Proof(token);
        });
        if (out instanceof Refused r) throw new DomainException.RuleViolated(r.code(), r.message());
        return ((Proof) out).token();
    }

    /** Cast the unit's vote: final once cast. */
    public Receipt cast(Caller c, UUID ballotId, UUID unitId, String proof, String choice) {
        return tx.inTx(() -> {
            Voter v = voter(c, ballotId, unitId, true);   // the ballot is locked: one vote at a time, so the chain has no gaps or forks
            Ballot b = v.ballot();
            if (choice == null || !b.options.contains(choice)) throw new DomainException.RuleViolated("bad-choice", "That is not an option on this ballot");
            Challenge ch = store.challenge(ballotId, v.elector().unitId(), v.person()).orElse(null);
            Instant now = clock.instant();
            boolean ok = ch != null && ch.proofHash() != null && proof != null && Crypto.constantTimeEquals(ch.proofHash(), Crypto.sha256(proof)) && !now.isAfter(ch.proofExpiresAt());
            if (ch != null && ch.proofHash() != null) store.deleteChallenge(ch.id());   // single use, right or wrong
            if (!ok) throw new DomainException.RuleViolated("no-proof", "Second-factor check missing or expired - request a new code");
            String receipt = HexFormat.of().formatHex(Crypto.sha256(Crypto.randomToken(16))).substring(0, 12);
            Governance.BoxRow row = Governance.next(b.chainHead, b.votesCast, receipt, choice);
            store.cast(b, new GovernanceStore.Mark(ballotId, v.elector().unitId(), v.elector().unitNo(), c.membership().value(), c.displayName(), today()), row);
            audit.write(c, AuditWriter.Action.Create, "governance.vote_roll", ballotId, b.shortId, v.elector().unitId(), v.elector().unitNo() + " voted on “" + b.title + "”", List.of());
            return new Receipt(ballotId, row.seq(), row.receipt(), row.hash());
        });
    }
}
