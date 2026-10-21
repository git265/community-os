package com.communityos.api.identity.application.port;

import java.time.Duration;

/** Counts attempts per key in a sliding window; throws TooManyAttempts past `max`. Shared by all API instances (it is a table). */
public interface RateLimiter {
    void hit(String key, int max, Duration window);
}
