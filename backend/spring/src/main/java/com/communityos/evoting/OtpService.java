package com.communityos.evoting;

import com.communityos.domain.OutboundMessage;
import com.communityos.port.DocumentRepository;
import com.communityos.port.OutboundChannel;
import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.communityos.service.Tx;
import com.communityos.web.BadRequestException;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The second factor of e-voting: requestOtp / verifyOtp of src/lib/evoting.js, now on the server. A 6-digit code goes to the owner's registered
 * mobile (5 minutes, 3 tries, 30 seconds between codes, kept only as a salted hash) and a right code becomes a single-use proof (2 minutes) that
 * the voter-roll write demands.
 *
 * Delivery (app.evoting.delivery): `sms` sends it through the SMS channel (the response never contains the code); `log` writes it to the server log;
 * `echo` returns it in the response, which is only for a demo and is refused at start-up when app.payments.allow-simulated=false.
 */
public class OtpService {
    private static final Logger log = LoggerFactory.getLogger(OtpService.class);
    static final long OTP_TTL = 5 * 60_000L, OTP_GAP = 30_000L, PROOF_TTL = 2 * 60_000L;
    static final int OTP_TRIES = 3;

    private final EVotingState state;
    private final DocumentRepository repo;
    private final Tx tx;
    private final Clock clock;
    private final RandomSource random;
    private final OutboundChannel sms;
    private final String delivery;

    public OtpService(EVotingState state, DocumentRepository repo, Tx tx, Clock clock, RandomSource random, OutboundChannel sms, String delivery) {
        this.state = state; this.repo = repo; this.tx = tx; this.clock = clock; this.random = random; this.sms = sms; this.delivery = delivery == null ? "log" : delivery;
    }

    /** What the screen is told after a code was sent: the end of the mobile number, and the code itself only in `echo` mode. */
    public record Sent(String phoneLast4, long expiresIn, String code) {}

    private JsonNode ballot(String tenant, String ballotId) {
        if (ballotId == null || ballotId.isBlank()) throw new BadRequestException("No such ballot");
        return repo.get(tenant, "ballots", ballotId).orElseThrow(() -> new BadRequestException("No such ballot"));
    }

    private record Issued(String code, String phoneLast4, String ownerName) {}

    public Sent request(String tenant, Principal p, String ballotId) {
        JsonNode ballot = ballot(tenant, ballotId);
        String reason = EVotingRules.whyCannotVote(ballot, p, EVotingRules.todayStr(clock));
        if (!reason.isEmpty()) throw new BadRequestException(reason);
        String key = EVotingRules.keyOf(Js.toStr(Js.f(ballot, "id")), p.unit(), p.name());
        String phone = "sms".equals(delivery) ? ownerPhone(tenant, p) : "";
        if ("sms".equals(delivery) && phone.isEmpty()) throw new BadRequestException("No mobile number is registered for you on the owners’ register. Please ask the office.");
        // the whole step is one transaction; a refusal inside it changes nothing
        Issued issued = tx.run(() -> {
            long now = clock.millis();
            EVotingState.Challenge prev = state.challenge(tenant, key, true);
            if (prev != null && now - prev.sentAt() < OTP_GAP)
                throw new BadRequestException("Please wait " + (long) Math.ceil((OTP_GAP - (now - prev.sentAt())) / 1000.0) + " seconds before asking for another code.");
            String code = String.valueOf(100000 + (random.uint32() % 900000));
            String salt = random.hex(8);
            state.saveChallenge(tenant, key, new EVotingState.Challenge(salt, EVotingRules.sha256Hex(salt + ":" + key + ":" + code), now + OTP_TTL, 0, now));
            JsonNode entry = EVotingRules.rollEntryFor(ballot, p.unit());
            String ownerName = null;
            for (JsonNode o : Js.list(entry, "owners")) if (EVotingRules.sameName(Js.orEmpty(o), p.name())) { ownerName = Js.orEmpty(o); break; }
            JsonNode byName = ownerName == null ? Js.MISSING : Js.f(Js.f(entry, "phones"), ownerName);
            String last4 = Js.truthy(byName) ? Js.toStr(byName) : Js.truthy(entry, "phoneLast4") ? Js.toStr(Js.f(entry, "phoneLast4")) : "";
            return new Issued(code, last4, ownerName);
        });
        switch (delivery) {
            case "sms" -> {
                try {
                    sms.send(new OutboundMessage("evote-otp", sms.channel(), phone, p.name() == null ? "" : p.name(), "",
                            "Your voting code is " + issued.code() + ". It works for 5 minutes. Do not share it with anyone."));
                } catch (Exception e) {
                    log.warn("e-voting code could not be sent: {}", e.getMessage());
                    tx.run(() -> state.deleteChallenge(tenant, key));
                    throw new BadRequestException("We could not send the code. Please try again in a moment.");
                }
            }
            case "echo" -> { /* returned below */ }
            default -> log.info("[e-voting code] {} {} {}: {}", tenant, p.unit(), p.name(), issued.code());
        }
        return new Sent(issued.phoneLast4(), OTP_TTL / 1000, "echo".equals(delivery) ? issued.code() : null);
    }

    private sealed interface Outcome permits Proof, Refused {}
    private record Proof(String token) implements Outcome {}
    private record Refused(String message) implements Outcome {}

    /** @return the single-use proof; @throws BadRequestException with the message the screen shows */
    public String verify(String tenant, Principal p, String ballotId, String code) {
        String key = EVotingRules.keyOf(ballotId == null ? "undefined" : ballotId, p.unit(), p.name());
        // wrong tries and expiry are RECORDED even though the answer is a refusal, so the outcome is returned and thrown after the transaction commits
        Outcome out = tx.run(() -> {
            long now = clock.millis();
            EVotingState.Challenge ch = state.challenge(tenant, key, true);
            if (ch == null) return new Refused("Ask for a code first.");
            if (now > ch.exp()) { state.deleteChallenge(tenant, key); return new Refused("That code has expired. Ask for a new one."); }
            if (ch.tries() >= OTP_TRIES) { state.deleteChallenge(tenant, key); return new Refused("Too many wrong attempts. Ask for a new code."); }
            EVotingState.Challenge next = new EVotingState.Challenge(ch.salt(), ch.hash(), ch.exp(), ch.tries() + 1, ch.sentAt());
            state.saveChallenge(tenant, key, next);
            if (!EVotingRules.sha256Hex(ch.salt() + ":" + key + ":" + Js.trim(code == null ? "undefined" : code)).equals(ch.hash())) {
                int left = OTP_TRIES - next.tries();
                return new Refused("That code is not right (" + left + " attempt" + (left == 1 ? "" : "s") + " left).");
            }
            state.deleteChallenge(tenant, key);
            String token = random.hex(16);
            state.saveProof(tenant, token, key, now + PROOF_TTL);
            return new Proof(token);
        });
        if (out instanceof Refused r) throw new BadRequestException(r.message());
        return ((Proof) out).token();
    }

    /** The mobile number of this owner on the Properties register (the unit's primary owner, an additional owner, or the old secondary owner). */
    String ownerPhone(String tenant, Principal p) {
        for (JsonNode prop : repo.list(tenant, "properties")) {
            if (!Js.f(prop, "unit").isTextual() || !Js.f(prop, "unit").asText().equals(p.unit())) continue;
            List<String[]> owners = new ArrayList<>();   // name, phone
            if (Js.truthy(prop, "owner")) owners.add(new String[]{Js.toStr(Js.f(prop, "owner")), Js.orEmpty(Js.f(prop, "ownerPhone"))});
            List<JsonNode> extra = Js.list(prop, "people");
            for (JsonNode x : extra) {
                if (!Js.truthy(x, "name")) continue;
                String relation = Js.truthy(x, "relation") ? Js.toStr(Js.f(x, "relation")) : "Additional owner";
                if ("Additional owner".equals(relation)) owners.add(new String[]{Js.toStr(Js.f(x, "name")), Js.orEmpty(Js.f(x, "phone"))});
            }
            if (extra.isEmpty() && Js.truthy(prop, "secondaryOwner")) owners.add(new String[]{Js.toStr(Js.f(prop, "secondaryOwner")), Js.orEmpty(Js.f(prop, "secondaryOwnerPhone"))});
            for (String[] o : owners) if (EVotingRules.sameName(o[0], p.name()) && !o[1].isBlank()) return o[1].trim();
        }
        return "";
    }
}
