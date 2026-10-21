package com.communityos.api.shared.security;

/** A signed call from outside (a provider webhook, a partner request) whose signature does not match: HTTP 401, nothing processed. */
public final class BadSignature extends RuntimeException {
    public BadSignature() { super("signature does not match"); }
}
