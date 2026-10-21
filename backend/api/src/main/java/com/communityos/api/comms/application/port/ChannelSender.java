package com.communityos.api.comms.application.port;

/**
 * Sends one queued channel message (WhatsApp, SMS or e-mail) through a provider. In-app notifications need none of this; a member's extra
 * channels do. Without a provider (cos.channels.provider=none, the default) messages stay Queued and nothing leaves the server.
 */
public interface ChannelSender {
    record Result(boolean sent, String providerRef, String error) {
        public static Result ok(String ref) { return new Result(true, ref, null); }
        public static Result failed(String error) { return new Result(false, null, error); }
    }
    /** The provider's name, kept with each message it sends ("simulated", "msg91" ...). */
    String name();
    Result send(String channel, String to, String subject, String body);
}
