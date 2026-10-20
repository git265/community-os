package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Locale;

/**
 * One poll answer per villa. A second member of the same household changes the household's answer instead of adding another: a vote for a unit
 * that already has an answer from a DIFFERENT person is refused. A port of pollPreWrite in src/lib/propertyServer.js (it applies to everyone,
 * the Super Admin included).
 */
public final class PollRules {
    private PollRules() {}

    public static boolean covers(String collection) { return "pollVotes".equals(collection); }

    /** @return the reason to refuse, or "" when the vote may go ahead */
    public static String preWrite(JsonNode record, RawReader raw) {
        if (!Js.truthy(record, "unit")) return "";
        JsonNode first = null;
        for (JsonNode v : raw.read("pollVotes")) {
            if (Js.strictEq(Js.f(v, "broadcastId"), Js.f(record, "broadcastId")) && Js.strictEq(Js.f(v, "unit"), Js.f(record, "unit")) && !Js.strictEq(Js.f(v, "id"), Js.f(record, "id"))) { first = v; break; }
        }
        if (first == null || sameName(Js.f(first, "voter"), Js.f(record, "voter"))) return "";
        JsonNode by = Js.f(first, "voter");
        return Js.str(record, "unit") + " has already voted on this poll (by " + (by.isMissingNode() ? "undefined" : by.isNull() ? "null" : Js.str(by)) + "). There is one vote per villa.";
    }

    /** `String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()` */
    static boolean sameName(JsonNode a, JsonNode b) { return norm(a).equals(norm(b)); }

    private static String norm(JsonNode n) {
        String s = Js.truthy(n) ? Js.str(n) : "";
        return MoneyGuard.trim(s).toLowerCase(Locale.ROOT);
    }
}
