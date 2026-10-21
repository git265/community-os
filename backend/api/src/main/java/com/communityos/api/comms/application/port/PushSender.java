package com.communityos.api.comms.application.port;

/** Sends one push message to one browser / device subscription (Web Push), or only writes it down (development / tests). */
public interface PushSender {
    record Subscription(String endpoint, String p256dh, String auth) {}
    record Message(String title, String body, String link, String tag) {}
    /** status: the push service's HTTP answer (201 delivered; 404 / 410 the subscription is gone; 429 / 5xx try again later). */
    record Result(int status, String error) {
        public boolean delivered() { return status >= 200 && status < 300; }
        public boolean gone() { return status == 404 || status == 410; }
        public boolean retry() { return status == 0 || status == 408 || status == 429 || status >= 500; }
    }
    String name();
    /** The public key browsers subscribe with (base64url), null when this sender needs none. */
    String publicKey();
    Result send(Subscription to, Message m);
}
