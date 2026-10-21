package com.communityos.api.shared.events;

import com.communityos.api.shared.resilience.RetryPolicy;
import com.communityos.api.shared.resilience.TransientFailure;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Delivers outbox events (at-least-once). Each pass claims a batch with SELECT ... FOR UPDATE SKIP LOCKED (so several API instances never send
 * the same event at the same time), publishes each, and either marks it Sent or schedules the next attempt with exponential backoff; after
 * maxAttempts it is marked Dead for a person to look at. Consumers de-duplicate on event_id.
 */
public final class OutboxRelay {
    /** Port over the outbox table (JdbcOutboxStore). */
    public interface Store {
        List<OutboxMessage> claimDue(int batch, Instant now);
        void markSent(long id, Instant at);
        void retryLater(long id, int attempts, Instant next, String error);
        void markDead(long id, int attempts, String error);
    }

    private final Store store; private final EventPublisher publisher; private final RetryPolicy backoff; private final int maxAttempts; private final Clock clock;

    public OutboxRelay(Store store, EventPublisher publisher, int maxAttempts, Clock clock) {
        this.store = store; this.publisher = publisher; this.maxAttempts = maxAttempts; this.clock = clock;
        this.backoff = new RetryPolicy(maxAttempts, Duration.ofSeconds(5), Duration.ofHours(1), TransientFailure::is);
    }

    /** One pass; returns how many were sent. Called by a scheduler (OutboxScheduler) every few seconds. */
    public int runOnce(int batch) {
        int sent = 0;
        for (OutboxMessage m : store.claimDue(batch, clock.instant())) {
            try { publisher.publish(m); store.markSent(m.id(), clock.instant()); sent++; }
            catch (RuntimeException e) {
                int attempts = m.attempts() + 1;
                String why = e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage());
                if (attempts >= maxAttempts || !TransientFailure.is(e)) store.markDead(m.id(), attempts, why);
                else store.retryLater(m.id(), attempts, clock.instant().plus(backoff.backoff(attempts).plusSeconds(1)), why);
            }
        }
        return sent;
    }
}
