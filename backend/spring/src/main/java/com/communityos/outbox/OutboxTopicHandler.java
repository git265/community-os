package com.communityos.outbox;

/**
 * Plug-in for one topic: a Spring bean that implements this is called for every event of its topic (payment.settled -> receipt mail, invoice,
 * accounting export ...). Throw to have the event retried with back-off; it is parked as Dead after app.outbox.max-attempts.
 */
public interface OutboxTopicHandler {
    String topic();
    void handle(OutboxEvent event) throws Exception;
}
