package com.communityos.api.comms.adapter;

import com.communityos.api.comms.application.port.PushSender;
import com.communityos.api.shared.http.HttpTransport;
import com.communityos.api.shared.push.WebPush;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/** Web Push to the browser's own push service (RFC 8291 encryption, RFC 8292 VAPID); the payload is the notification's title, text and link. */
public final class WebPushSender implements PushSender {
    private final HttpTransport http; private final WebPush.Vapid vapid; private final String subject; private final ObjectMapper json; private final Clock clock;
    public WebPushSender(HttpTransport http, WebPush.Vapid vapid, String subject, ObjectMapper json, Clock clock) {
        this.http = http; this.vapid = vapid; this.subject = subject; this.json = json; this.clock = clock;
    }
    @Override public String name() { return "webpush"; }
    @Override public String publicKey() { return vapid.publicKeyB64(); }
    @Override public Result send(Subscription to, Message m) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("title", m.title()); payload.put("body", m.body().length() > 600 ? m.body().substring(0, 600) + "…" : m.body());
        payload.put("link", m.link()); payload.put("tag", m.tag());
        byte[] body;
        try { body = WebPush.encrypt(json.writeValueAsBytes(payload), to.p256dh(), to.auth()); }
        catch (Exception e) { return new Result(400, "could not encrypt: " + e.getMessage()); }
        HttpTransport.Request r = new HttpTransport.Request("POST", URI.create(to.endpoint()), new LinkedHashMap<>(), body, Duration.ofSeconds(10))
            .header("Content-Type", "application/octet-stream").header("Content-Encoding", "aes128gcm").header("TTL", "86400").header("Urgency", "normal")
            .header("Topic", m.tag() == null ? "cos" : m.tag().replaceAll("[^A-Za-z0-9_-]", "").substring(0, Math.min(32, m.tag().replaceAll("[^A-Za-z0-9_-]", "").length())))
            .header("Authorization", WebPush.vapidHeader(vapid, to.endpoint(), subject, clock.instant()));
        try {
            HttpTransport.Response res = http.send(r);
            return new Result(res.status(), res.status() >= 300 ? ("push service answered " + res.status() + ": " + abbreviate(res.text())) : null);
        } catch (RuntimeException e) { return new Result(0, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()); }
    }
    static String abbreviate(String s) { return s == null ? "" : s.length() > 200 ? s.substring(0, 200) : s; }
}
