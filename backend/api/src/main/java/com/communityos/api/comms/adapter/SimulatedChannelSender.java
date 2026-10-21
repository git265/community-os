package com.communityos.api.comms.adapter;

import com.communityos.api.comms.application.port.ChannelSender;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Development only (cos.channels.provider=simulated, refused in prod): "sends" each message by writing it to the log, and marks it Sent. */
public final class SimulatedChannelSender implements ChannelSender {
    private static final Logger log = LoggerFactory.getLogger(SimulatedChannelSender.class);
    @Override public String name() { return "simulated"; }
    @Override public Result send(String channel, String to, String subject, String body) {
        log.info("[simulated {}] to {}: {} - {}", channel, mask(to), subject, body == null ? "" : body.length() > 160 ? body.substring(0, 160) + "..." : body);
        return Result.ok("sim-" + UUID.randomUUID().toString().substring(0, 12));
    }
    static String mask(String to) { return to == null || to.length() < 5 ? "?" : to.substring(0, 3) + "***" + to.substring(to.length() - 2); }
}
