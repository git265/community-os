package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/** Comparing an incoming record with the stored one (changedKeys / onlyKeys / forbidKeys in authz.js). */
final class Changes {
    private Changes() {}

    static boolean isMeta(String key) { return RowScopes.META_KEYS.contains(key); }

    /** The fields of `next` whose value differs from `old` (meta fields excluded), in the order they appear in `next`. */
    static List<String> changedKeys(JsonNode old, JsonNode next) {
        List<String> out = new ArrayList<>();
        if (next == null || !next.isObject()) return out;
        for (Iterator<String> it = next.fieldNames(); it.hasNext(); ) {
            String k = it.next();
            if (isMeta(k)) continue;
            if (Js.differs(next.get(k), Js.f(old, k))) out.add(k);
        }
        return out;
    }

    /** Keys of `next` other than the META ones (what a create carries). */
    static List<String> keysOf(JsonNode next) {
        List<String> out = new ArrayList<>();
        if (next == null || !next.isObject()) return out;
        for (Iterator<String> it = next.fieldNames(); it.hasNext(); ) { String k = it.next(); if (!isMeta(k)) out.add(k); }
        return out;
    }

    static Verdict onlyKeys(JsonNode old, JsonNode next, List<String> allowed, String who) {
        List<String> bad = changedKeys(old, next).stream().filter((k) -> !allowed.contains(k)).toList();
        return bad.isEmpty() ? Verdict.OK : Verdict.deny(who + " may not change: " + String.join(", ", bad));
    }

    static Verdict forbidKeys(JsonNode old, JsonNode next, List<String> forbidden, String who) {
        List<String> bad = changedKeys(old, next).stream().filter(forbidden::contains).toList();
        return bad.isEmpty() ? Verdict.OK : Verdict.deny(who + " may not change: " + String.join(", ", bad));
    }

    /** 'Pending', '', undefined or null: an approval put back to its starting state. */
    static boolean isResetValue(JsonNode v) {
        if (v == null || v.isMissingNode() || v.isNull()) return true;
        return v.isTextual() && (v.asText().equals("Pending") || v.asText().isEmpty());
    }

    /** `x.key || ''` as text. */
    static String orEmpty(JsonNode rec, String key) { JsonNode v = Js.f(rec, key); return Js.truthy(v) ? Js.str(v) : ""; }
}
