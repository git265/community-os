package com.communityos.api.shared.resilience;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

/**
 * Decorator that wraps an outbound call in, from the inside out: a TIMEOUT per attempt, the CIRCUIT BREAKER, and RETRY with backoff.
 * Every call to a payment provider, SMS / WhatsApp / e-mail gateway or webhook receiver goes through one of these (one instance per provider),
 * so a slow or failing provider costs at most timeout x attempts and then fails fast for everyone.
 */
public final class Resilient {
    public interface Sleeper { void sleep(Duration d) throws InterruptedException; }

    private final Duration timeout; private final CircuitBreaker breaker; private final RetryPolicy retry; private final Sleeper sleeper;
    private static final ExecutorService POOL = Executors.newVirtualThreadPerTaskExecutor();

    public Resilient(Duration timeout, CircuitBreaker breaker, RetryPolicy retry, Sleeper sleeper) {
        this.timeout = timeout; this.breaker = breaker; this.retry = retry; this.sleeper = sleeper;
    }
    public Resilient(Duration timeout, CircuitBreaker breaker, RetryPolicy retry) { this(timeout, breaker, retry, (d) -> Thread.sleep(d.toMillis())); }

    public <T> T call(Supplier<T> work) {
        RuntimeException last = null;
        for (int attempt = 1; attempt <= retry.maxAttempts(); attempt++) {
            try { return breaker.call(() -> withTimeout(work)); }
            catch (RuntimeException e) {
                last = e;
                if (attempt == retry.maxAttempts() || !retry.retryOn().test(e)) throw e;
                try { sleeper.sleep(retry.backoff(attempt)); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); throw e; }
            }
        }
        throw last;
    }

    private <T> T withTimeout(Supplier<T> work) {
        if (timeout.isZero()) return work.get();
        CompletableFuture<T> f = CompletableFuture.supplyAsync(work, POOL);
        try { return f.get(timeout.toMillis(), TimeUnit.MILLISECONDS); }
        catch (TimeoutException e) { f.cancel(true); throw new TransientFailure("timed out after " + timeout.toMillis() + " ms", e); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new TransientFailure("interrupted", e); }
        catch (ExecutionException e) { if (e.getCause() instanceof RuntimeException re) throw re; throw new TransientFailure("failed", e.getCause()); }
    }
}
