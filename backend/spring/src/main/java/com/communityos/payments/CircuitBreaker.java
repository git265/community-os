package com.communityos.payments;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.LongSupplier;

/**
 * A small circuit breaker with a timeout, for calls to an outside service (the payment provider's status API).
 * closed -> (N failures in a row) -> open: calls fail at once for `resetMs` -> half-open: ONE trial call; success closes it, failure re-opens it.
 * Why: a slow provider must not tie up every request slot waiting for it.
 */
public class CircuitBreaker {
    public static class OpenException extends RuntimeException {
        public OpenException(String name) { super(name + " is not responding; try again in a moment."); }
    }
    public static class TimedOutException extends RuntimeException {
        public TimedOutException(String name, long ms) { super(name + " took longer than " + ms + " ms."); }
    }

    public enum State { CLOSED, OPEN, HALF_OPEN }

    private final String name;
    private final long timeoutMs, resetMs;
    private final int threshold;
    private final LongSupplier now;
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> { Thread t = new Thread(r, "breaker-call"); t.setDaemon(true); return t; });
    private State state = State.CLOSED;
    private int failures;
    private long openedAt;
    private boolean trial;

    public CircuitBreaker(String name, long timeoutMs, int failureThreshold, long resetMs) { this(name, timeoutMs, failureThreshold, resetMs, System::currentTimeMillis); }

    public CircuitBreaker(String name, long timeoutMs, int failureThreshold, long resetMs, LongSupplier now) {
        this.name = name; this.timeoutMs = timeoutMs; this.threshold = failureThreshold; this.resetMs = resetMs; this.now = now;
    }

    public <T> T call(Callable<T> fn) throws Exception {
        admit();
        try {
            Future<T> f = pool.submit(fn);
            T v;
            try { v = f.get(timeoutMs, TimeUnit.MILLISECONDS); }
            catch (TimeoutException e) { f.cancel(true); throw new TimedOutException(name, timeoutMs); }
            catch (ExecutionException e) { throw e.getCause() instanceof Exception ex ? ex : e; }
            succeeded();
            return v;
        } catch (Exception e) {
            failed();
            throw e;
        }
    }

    private synchronized void admit() {
        if (state == State.OPEN) {
            if (now.getAsLong() - openedAt < resetMs) throw new OpenException(name);
            state = State.HALF_OPEN; trial = false;
        }
        if (state == State.HALF_OPEN) {
            if (trial) throw new OpenException(name);
            trial = true;
        }
    }

    private synchronized void succeeded() { failures = 0; state = State.CLOSED; }

    private synchronized void failed() {
        failures++;
        if (state == State.HALF_OPEN || failures >= threshold) { state = State.OPEN; openedAt = now.getAsLong(); }
    }

    public synchronized State state() { return state; }
}
