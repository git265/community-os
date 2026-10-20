package com.communityos.port;

import com.communityos.domain.OutboundMessage;

/** PORT: one way of reaching a person (Email, SMS, WhatsApp). Adapters: logging, SMTP, generic HTTP (Twilio, MSG91, Meta ...). */
public interface OutboundChannel {
    /** The channel name used on outbox rows: "Email", "SMS", "WhatsApp". */
    String channel();
    /** Provider id for /health, e.g. "smtp". */
    String provider();
    /** @throws Exception when the provider refused; the dispatcher marks the row Failed and retries later. */
    void send(OutboundMessage message) throws Exception;
}
