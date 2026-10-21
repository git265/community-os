package com.communityos.api.shared.web;

import com.communityos.api.shared.domain.DomainException;

/**
 * Optimistic concurrency over HTTP: GET returns ETag: "<version>", a change must send If-Match with it. Someone else's save in between gives
 * 412/409 instead of silently overwriting their work ("lost update").
 */
public final class ETags {
    private ETags() {}
    public static String of(long version) { return "\"" + version + "\""; }
    public static long require(String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank()) throw new DomainException.RuleViolated("precondition-required", "Send If-Match with the version you last read");
        String v = ifMatch.trim();
        if (v.startsWith("W/")) v = v.substring(2);
        v = v.replace("\"", "");
        try { return Long.parseLong(v); } catch (NumberFormatException e) { throw new DomainException.RuleViolated("precondition-required", "If-Match is not a version"); }
    }
}
