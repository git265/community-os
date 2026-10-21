package com.communityos.api.shared.resilience;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.function.Supplier;

/**
 * Circuit breaker (State pattern: CLOSED -> OPEN -> HALF_OPEN). After `failureThreshold` consecutive failures the breaker opens and calls fail
 * fast (no waiting on a provider that is down, no thread pile-up); after `openFor` one trial call is let through (half-open): success closes it,
 * failure opens it again. Thread-safe.
 */
public final class CircuitBreaker {
    public enum State { CLOSED, OPEN, HALF_OPEN }
    public static final class OpenException extends RuntimeException { public OpenException(String name) { super(name + " is unavailable right now - try again shortly"); } }

    private final String name; private final int failureThreshold; private final Duration openFor; private final Clock clock;
    private State state = State.CLOSED; private int failures; private Instant openedAt = Instant.EPOCH; private boolean trialInFlight;

    public CircuitBreaker(String name, int failureThreshold, Duration openFor, Clock clock) {
        this.name = name; this.failureThreshold = failureThreshold; this.openFor = openFor; this.clock = clock;
    }

    public <T> T call(Supplier<T> work) {
        acquire();
        try { T out = work.get(); onSuccess(); return out; }
        catch (RuntimeException e) { onFailure(e); throw e; }
    }

    private synchronized void acquire() {
        if (state == State.OPEN) {
            if (clock.instant().isBefore(openedAt.plus(openFor))) throw new OpenException(name);
            state = State.HALF_OPEN; trialInFlight = false;
        }
        if (state == State.HALF_OPEN) { if (trialInFlight) throw new OpenException(name); trialInFlight = true; }
    }
    private synchronized void onSuccess() { state = State.CLOSED; failures = 0; trialInFlight = false; }
    private synchronized void onFailure(RuntimeException e) {
        if (!TransientFailure.is(e)) { if (state == State.HALF_OPEN) { state = State.CLOSED; failures = 0; trialInFlight = false; } return; }   // a 4xx is not the provider being down
        failures++; trialInFlight = false;
        if (state == State.HALF_OPEN || failures >= failureThreshold) { state = State.OPEN; openedAt = clock.instant(); }
    }
    public synchronized State state() { return state; }
}
