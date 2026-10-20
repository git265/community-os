package com.communityos.security;

/** A write rule for one collection. Returns {@link Verdict#OK}, a refusal, or null meaning "no opinion: carry on with the normal field checks". */
@FunctionalInterface
public interface Rule {
    Verdict check(WriteCall call);
}
