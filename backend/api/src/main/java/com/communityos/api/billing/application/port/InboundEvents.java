package com.communityos.api.billing.application.port;

import java.util.UUID;

/**
 * De-duplication of provider webhooks (integration.inbound_event). A provider sends the same event several times; it is processed once.
 * `alreadyProcessed` is checked first; `markProcessed` only after the work committed, so a failure is retried on the provider's next delivery.
 */
public interface InboundEvents {
    boolean alreadyProcessed(String provider, String eventId);
    void received(String provider, String eventId, UUID community, String type);
    void markProcessed(String provider, String eventId);
}
