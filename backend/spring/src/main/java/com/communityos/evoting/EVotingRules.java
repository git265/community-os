package com.communityos.evoting;

import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

/**
 * The pure rules of e-voting, the Java form of the first half of src/lib/evoting.js: who may vote, the fingerprint of the voter roll, and the
 * hash chain of the ballot box. (The screen-only helpers, building the roll from the Properties register and counting the result, stay in the browser.)
 */
public final class EVotingRules {
    private EVotingRules() {}

    public static final String GENESIS = "0".repeat(64);

    /** `new Date().toISOString().slice(0, 10)`: the UTC date. */
    public static String todayStr(Clock clock) { return LocalDate.now(clock.withZone(ZoneOffset.UTC)).toString(); }

    // ---- SHA-256 ----------------------------------------------------------------------------------------------------------

    /** UTF-8 the way TextEncoder writes it: a lone surrogate becomes U+FFFD (Java would write "?"). */
    static byte[] utf8(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) { sb.append(c).append(s.charAt(++i)); }
            else if (Character.isSurrogate(c)) sb.append('�');
            else sb.append(c);
        }
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    public static String sha256Hex(String text) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(utf8(text));
            StringBuilder sb = new StringBuilder(64);
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    /** `sha256Hex(JSON.stringify(roll))` */
    public static String rollHash(JsonNode roll) { return sha256Hex(Js.stringify(roll)); }

    // ---- who may vote -----------------------------------------------------------------------------------------------------

    /** `a < b` where b came from a record: only two texts compare (JavaScript turns anything else into NaN, and NaN is never smaller). */
    private static boolean before(String a, JsonNode b) { return b != null && b.isTextual() && a.compareTo(b.asText()) < 0; }
    private static boolean after(String a, JsonNode b) { return b != null && b.isTextual() && a.compareTo(b.asText()) > 0; }

    /** The roll entry of a unit: the first one whose unit is exactly this text, or null. */
    public static JsonNode rollEntryFor(JsonNode ballot, String unit) {
        for (JsonNode r : Js.list(ballot, "roll")) if (Js.f(r, "unit").isTextual() && Js.f(r, "unit").asText().equals(unit)) return r;
        return null;
    }

    /** May this signed-in person vote for this unit on this ballot? "" when yes, otherwise the reason (whyCannotVote). */
    public static String whyCannotVote(JsonNode ballot, Principal p, String today) {
        if (ballot == null || ballot.isMissingNode() || ballot.isNull() || p == null) return "Not signed in";
        if (!Js.is(ballot, "status", "Open")) return Js.is(ballot, "status", "Draft") ? "Voting has not opened yet" : "Voting is closed";
        if (before(today, Js.f(ballot, "opensOn"))) return "Voting opens on " + Js.toStr(Js.f(ballot, "opensOn"));
        if (after(today, Js.f(ballot, "closesOn"))) return "The voting window has ended";
        if (!"owner".equals(p.roleId())) return "Only registered owners can vote (tenants and other residents are not on the owners’ roll)";
        JsonNode entry = rollEntryFor(ballot, p.unit());
        if (entry == null) return (p.unit().isEmpty() ? "Your unit" : p.unit()) + " is not on this ballot’s voter roll";
        boolean owner = false;
        for (JsonNode o : Js.list(entry, "owners")) if (sameName(Js.orEmpty(o), p.name())) { owner = true; break; }
        if (!owner) return "Only the registered owner of the unit can vote for it";
        return "";
    }

    /** `String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()` */
    public static boolean sameName(String a, String b) {
        return Js.trim(a == null ? "" : a).toLowerCase(java.util.Locale.ROOT).equals(Js.trim(b == null ? "" : b).toLowerCase(java.util.Locale.ROOT));
    }

    /** `${ballotId}|${unit}|${name.toLowerCase()}`, the key of one voter on one ballot. */
    public static String keyOf(String ballotId, String unit, String name) {
        return ballotId + "|" + unit + "|" + (name == null ? "undefined" : name).toLowerCase(java.util.Locale.ROOT);
    }

    // ---- the hash chain ---------------------------------------------------------------------------------------------------

    public static String chainHash(String prev, JsonNode seq, JsonNode receipt, JsonNode choice) {
        return sha256Hex(prev + "|" + Js.toStr(seq) + "|" + Js.toStr(receipt) + "|" + Js.toStr(choice));
    }

    public record Chain(boolean ok, String head, int count, int brokenAt) {}

    /** Recomputes the chain over a ballot's box rows. */
    public static Chain verifyChain(List<JsonNode> rows) {
        List<JsonNode> sorted = new ArrayList<>(rows);
        sorted.sort((a, b) -> { double d = Js.toNumber(Js.f(a, "seq")) - Js.toNumber(Js.f(b, "seq")); return Double.isNaN(d) ? 0 : d < 0 ? -1 : d > 0 ? 1 : 0; });
        String prev = GENESIS;
        for (int i = 0; i < sorted.size(); i++) {
            JsonNode r = sorted.get(i);
            JsonNode seq = Js.f(r, "seq");
            boolean seqOk = seq.isNumber() && seq.asDouble() == i + 1;
            if (!seqOk || !Js.f(r, "prevHash").isTextual() || !Js.f(r, "prevHash").asText().equals(prev)
                    || !Js.f(r, "hash").isTextual() || !Js.f(r, "hash").asText().equals(chainHash(prev, seq, Js.f(r, "receipt"), Js.f(r, "choice"))))
                return new Chain(false, prev, sorted.size(), i + 1);
            prev = Js.f(r, "hash").asText();
        }
        return new Chain(true, prev, sorted.size(), 0);
    }
}
