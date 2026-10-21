package com.communityos.api.shared.resilience;

import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Predicate;

/**
 * How to retry a call that can fail transiently (a payment provider, an SMS gateway, a webhook receiver): exponential backoff with FULL jitter
 * (a random wait between 0 and base x 2^attempt, capped), so many clients retrying at once spread out instead of hammering together.
 * Only failures that `retryOn` accepts are retried (timeouts, 5xx, connection resets) - never a 4xx or a business refusal.
 * Retry only idempotent work, or work carrying an idempotency key.
 */
public record RetryPolicy(int maxAttempts, Duration baseDelay, Duration maxDelay, Predicate<Throwable> retryOn) {
    public RetryPolicy {
        if (maxAttempts < 1) throw new IllegalArgumentException("maxAttempts >= 1");
        Objects.requireNonNull(baseDelay); Objects.requireNonNull(maxDelay); Objects.requireNonNull(retryOn);
    }
    public static RetryPolicy none() { return new RetryPolicy(1, Duration.ZERO, Duration.ZERO, (t) -> false); }
    public static RetryPolicy transientFailures(int maxAttempts) {
        return new RetryPolicy(maxAttempts, Duration.ofMillis(200), Duration.ofSeconds(5), TransientFailure::is);
    }
    /** Wait before attempt n+1 (n starts at 1): random in [0, min(maxDelay, base x 2^(n-1))]. */
    public Duration backoff(int attempt) {
        long cap = Math.min(maxDelay.toMillis(), baseDelay.toMillis() * (1L << Math.min(20, attempt - 1)));
        return Duration.ofMillis(cap <= 0 ? 0 : ThreadLocalRandom.current().nextLong(cap + 1));
    }
}
