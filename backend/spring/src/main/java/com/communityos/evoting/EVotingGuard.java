package com.communityos.evoting;

import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * Java form of `evotingPreWrite` (src/lib/evoting.js): runs before every write to ballots, voteRoll and ballotBox, for EVERY role, the Super Admin
 * included. It refuses, or says which server-controlled fields to overwrite: the roll fingerprint check and opening date, the closing seal, the
 * voter-roll mark (which uses up the second-factor proof), and the ballot-box row (position, receipt and link in the hash chain).
 */
public final class EVotingGuard {
    public static final Set<String> COLLECTIONS = Set.of("ballots", "voteRoll", "ballotBox");
    private static final List<String> OPEN_LOCKED_KEYS = List.of("title", "description", "kind", "options", "opensOn", "closesOn", "quorumPct", "passPct", "roll", "rollHash");

    private EVotingGuard() {}

    /** @param error the reason to refuse, or null; @param patch fields to overwrite; @param remove fields to take out of the record */
    public record Result(String error, ObjectNode patch, Set<String> remove) {
        static Result refuse(String why) { return new Result(why, null, Set.of()); }
    }

    public static boolean covers(String collection) { return COLLECTIONS.contains(collection); }

    public static Result preWrite(String tenant, String collection, ObjectNode record, JsonNode old, Principal p, Function<String, List<JsonNode>> list,
                                  EVotingState state, Clock clock, RandomSource random) {
        if (p == null) return Result.refuse("Not signed in");
        String today = EVotingRules.todayStr(clock);
        ObjectNode patch = record.objectNode();
        boolean hasOld = old != null && !old.isMissingNode() && !old.isNull();

        if ("ballots".equals(collection)) {
            if (hasOld && Js.is(old, "status", "Closed")) return Result.refuse("A closed ballot can never be changed");
            if (hasOld && Js.is(old, "status", "Open")) {
                for (String k : OPEN_LOCKED_KEYS) if (Js.differs(Js.f(record, k), Js.f(old, k))) return Result.refuse("An open ballot cannot be edited");
                if (Js.is(record, "status", "Open")) return new Result(null, patch, Set.of());
                if (!Js.is(record, "status", "Closed")) return Result.refuse("An open ballot can only be closed");
                if (before(today, Js.f(old, "closesOn"))) return Result.refuse("Voting stays open until " + Js.toStr(Js.f(old, "closesOn")));
                List<JsonNode> rows = boxRows(list, Js.f(old, "id"));
                EVotingRules.Chain chain = EVotingRules.verifyChain(rows);
                if (!chain.ok()) return Result.refuse("The ballot box failed its integrity check at vote " + chain.brokenAt() + "; it cannot be closed normally");
                patch.put("closedAt", today).put("chainHead", chain.head()).put("votesCounted", chain.count());
                return new Result(null, patch, Set.of());
            }
            if (Js.is(record, "status", "Open")) {   // Draft -> Open (or created open): freeze and fingerprint the electorate
                JsonNode roll = Js.f(record, "roll");
                if (!roll.isArray() || roll.isEmpty()) return Result.refuse("The voter roll is empty");
                if (!Js.f(record, "rollHash").isTextual() || !Js.f(record, "rollHash").asText().equals(EVotingRules.rollHash(roll))) return Result.refuse("The voter roll does not match its fingerprint");
                JsonNode options = Js.f(record, "options");
                if (!options.isArray() || options.size() < 2) return Result.refuse("A ballot needs at least two options");
                patch.put("openedAt", today);
                return new Result(null, patch, Set.of());
            }
            if (Js.is(record, "status", "Closed")) return Result.refuse("A ballot must be opened before it is closed");
            return new Result(null, patch, Set.of());
        }

        if (hasOld) return Result.refuse("Voting records can never be changed or deleted");
        JsonNode ballotId = Js.f(record, "ballotId");
        JsonNode ballot = null;
        if (Js.truthy(ballotId)) for (JsonNode b : list.apply("ballots")) if (Js.strictEq(Js.f(b, "id"), ballotId)) { ballot = b; break; }
        if (ballot == null) return Result.refuse("No such ballot");

        if ("voteRoll".equals(collection)) {
            String why = EVotingRules.whyCannotVote(ballot, p, today);
            if (!why.isEmpty()) return Result.refuse(why);
            if (!Js.f(record, "unit").isTextual() || !Js.f(record, "unit").asText().equals(p.unit())) return Result.refuse("You can only vote for the unit you are signed in as");
            for (JsonNode r : list.apply("voteRoll")) {
                if (Js.strictEq(Js.f(r, "ballotId"), Js.f(ballot, "id")) && Js.f(r, "unit").isTextual() && Js.f(r, "unit").asText().equals(p.unit()))
                    return Result.refuse(p.unit() + " has already voted on this ballot" + (Js.truthy(r, "owner") ? " (by " + Js.toStr(Js.f(r, "owner")) + ")" : "") + " — one vote per villa");
            }
            String key = EVotingRules.keyOf(Js.toStr(Js.f(ballot, "id")), p.unit(), p.name());
            EVotingState.ProofHit pr = Js.f(record, "proof").isTextual() ? state.takeProof(tenant, Js.f(record, "proof").asText()) : null;   // single use, valid or not
            if (pr == null || !pr.key().equals(key) || clock.millis() > pr.exp()) return Result.refuse("Second-factor check missing or expired - request a new code");
            state.grantAllowance(tenant, key);
            if (p.name() == null) return new Result(null, patch.put("markedOn", today), Set.of("proof", "owner"));   // `owner: undefined` takes the field out
            patch.put("owner", p.name()).put("markedOn", today);
            return new Result(null, patch, Set.of("proof"));
        }

        if ("ballotBox".equals(collection)) {
            String key = EVotingRules.keyOf(Js.toStr(Js.f(ballot, "id")), p.unit(), p.name());
            if (!state.hasAllowance(tenant, key)) return Result.refuse("No verified voter roll mark for this ballot");
            if (!Js.is(ballot, "status", "Open")) return Result.refuse("Voting is closed");
            boolean option = false;
            for (JsonNode o : Js.list(ballot, "options")) if (Js.strictEq(o, Js.f(record, "choice"))) { option = true; break; }
            if (!option) return Result.refuse("That is not an option on this ballot");
            state.clearAllowance(tenant, key);
            List<JsonNode> rows = boxRows(list, Js.f(ballot, "id"));
            int seq = rows.size() + 1;
            String prev = EVotingRules.GENESIS;
            for (JsonNode r : rows) if (Js.f(r, "seq").isNumber() && Js.f(r, "seq").asDouble() == seq - 1) { if (Js.truthy(r, "hash")) prev = Js.toStr(Js.f(r, "hash")); break; }
            String receipt = random.hex(6);
            String hash = EVotingRules.chainHash(prev, record.numberNode(seq), record.textNode(receipt), Js.f(record, "choice"));
            patch.put("seq", seq).put("prevHash", prev).put("receipt", receipt).put("hash", hash);
            return new Result(null, patch, Set.of());
        }
        return Result.refuse("Unknown voting record");
    }

    private static boolean before(String a, JsonNode b) { return b != null && b.isTextual() && a.compareTo(b.asText()) < 0; }

    private static List<JsonNode> boxRows(Function<String, List<JsonNode>> list, JsonNode ballotId) {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode r : list.apply("ballotBox")) if (Js.strictEq(Js.f(r, "ballotId"), ballotId)) out.add(r);
        return out;
    }
}
