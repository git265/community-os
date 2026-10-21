package com.communityos.api.comms.adapter;

import com.communityos.api.comms.application.port.PushSender;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Development without the internet (cos.push.provider=log, refused in prod): each push is written to the log and counted as delivered. */
public final class LogPushSender implements PushSender {
    private static final Logger log = LoggerFactory.getLogger(LogPushSender.class);
    @Override public String name() { return "log"; }
    @Override public String publicKey() { return null; }
    @Override public Result send(Subscription to, Message m) {
        log.info("[push] {} -> {}: {}", m.tag(), to.endpoint().length() > 60 ? to.endpoint().substring(0, 60) + "…" : to.endpoint(), m.title());
        return new Result(201, null);
    }
}
