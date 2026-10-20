package com.communityos.payments;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class CircuitBreakerTest {
    final AtomicLong now = new AtomicLong(1000);
    final CircuitBreaker breaker = new CircuitBreaker("provider", 200, 3, 30_000, now::get);

    @Test
    void opensAfterThreeFailuresInARowThenTriesOnceAndClosesOnSuccess() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        for (int i = 0; i < 3; i++) assertThrows(IllegalStateException.class, () -> breaker.call(() -> { calls.incrementAndGet(); throw new IllegalStateException("down"); }));
        assertEquals(CircuitBreaker.State.OPEN, breaker.state());
        assertThrows(CircuitBreaker.OpenException.class, () -> breaker.call(() -> { calls.incrementAndGet(); return 1; }));
        assertEquals(3, calls.get());   // an open breaker does not even try
        now.addAndGet(30_001);
        assertEquals(7, (int) breaker.call(() -> 7));   // the one trial call
        assertEquals(CircuitBreaker.State.CLOSED, breaker.state());
    }

    @Test
    void aFailedTrialReopensIt() throws Exception {
        for (int i = 0; i < 3; i++) assertThrows(IllegalStateException.class, () -> breaker.call(() -> { throw new IllegalStateException("down"); }));
        now.addAndGet(30_001);
        assertThrows(IllegalStateException.class, () -> breaker.call(() -> { throw new IllegalStateException("still down"); }));
        assertEquals(CircuitBreaker.State.OPEN, breaker.state());
        assertThrows(CircuitBreaker.OpenException.class, () -> breaker.call(() -> 1));
    }

    @Test
    void aSlowCallIsCutOff() {
        assertThrows(CircuitBreaker.TimedOutException.class, () -> breaker.call(() -> { Thread.sleep(2000); return 1; }));
    }

    @Test
    void aSuccessResetsTheFailureCount() throws Exception {
        for (int i = 0; i < 2; i++) assertThrows(IllegalStateException.class, () -> breaker.call(() -> { throw new IllegalStateException("x"); }));
        assertEquals(1, (int) breaker.call(() -> 1));
        for (int i = 0; i < 2; i++) assertThrows(IllegalStateException.class, () -> breaker.call(() -> { throw new IllegalStateException("x"); }));
        assertEquals(CircuitBreaker.State.CLOSED, breaker.state());
    }
}
