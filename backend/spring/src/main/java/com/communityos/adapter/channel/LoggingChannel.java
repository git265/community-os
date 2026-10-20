package com.communityos.adapter.channel;

import com.communityos.domain.OutboundMessage;
import com.communityos.port.OutboundChannel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Default: writes the message to the log instead of sending. Safe for development; nothing leaves the building. */
public class LoggingChannel implements OutboundChannel {
    private static final Logger log = LoggerFactory.getLogger(LoggingChannel.class);
    private final String channel;

    public LoggingChannel(String channel) { this.channel = channel; }

    @Override public String channel() { return channel; }
    @Override public String provider() { return "log"; }
    @Override public void send(OutboundMessage m) { log.info("[{}] to={} subject={} body={}", channel, m.to(), m.subject(), m.body()); }
}
