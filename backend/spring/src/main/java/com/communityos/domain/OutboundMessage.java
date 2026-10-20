package com.communityos.domain;

/** One message to send on one channel (Email, SMS, WhatsApp). `id` is the outbox record id, for logging. */
public record OutboundMessage(String id, String channel, String to, String toName, String subject, String body) {}
