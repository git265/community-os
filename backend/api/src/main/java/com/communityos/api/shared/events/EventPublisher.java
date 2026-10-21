package com.communityos.api.shared.events;

/**
 * Strategy: where outbox events go - outgoing signed webhooks today; a message broker (Kafka, SNS/SQS, Azure Service Bus) later, as another
 * implementation, without touching the modules that raise the events.
 */
public interface EventPublisher {
    /** Deliver one event; throw TransientFailure to have the relay retry it later with backoff. */
    void publish(OutboxMessage message);
}
