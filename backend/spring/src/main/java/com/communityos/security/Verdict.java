package com.communityos.security;

/** The answer of a write rule: allowed, or refused with a reason the person can read. */
public record Verdict(boolean ok, String reason) {
    public static final Verdict OK = new Verdict(true, null);
    public static Verdict deny(String reason) { return new Verdict(false, reason); }
}
