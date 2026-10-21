package com.communityos.api.shared.security;

/** A rate limit was reached (HTTP 429 with Retry-After). */
public final class TooManyAttempts extends RuntimeException {
    private final long retryAfterSeconds;
    public TooManyAttempts(long retryAfterSeconds) { super("Too many attempts - try again in a few minutes"); this.retryAfterSeconds = retryAfterSeconds; }
    public long retryAfterSeconds() { return retryAfterSeconds; }
}
