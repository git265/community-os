package com.communityos.outbox;

import com.communityos.config.AppProperties;
import com.communityos.service.Tx;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * Transactional outbox. Work that must happen AFTER something was saved is written as a row in the SAME transaction as the change (`emit`);
 * the worker (`dispatch`) then delivers it, retrying with back-off, and parks it as Dead after max-attempts. A crash between "payment saved"
 * and "message sent" can never lose the message, and a down mail server never undoes a payment.
 * `app.outbox.webhook-url`: when set, every event is also POSTed there as JSON (Idempotency-Key: outbox-<id>), to feed a queue through a connector.
 */
@Service
public class EventOutbox {
    private static final Logger log = LoggerFactory.getLogger(EventOutbox.class);

    public record Result(int sent, int retried, int dead) {}

    private final EventOutboxStore store;
    private final Tx tx;
    private final AppProperties.Outbox cfg;
    private final ObjectMapper json;
    private final Map<String, OutboxTopicHandler> handlers = new HashMap<>();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public EventOutbox(EventOutboxStore store, Tx tx, AppProperties props, ObjectMapper json, List<OutboxTopicHandler> handlers) {
        this.store = store; this.tx = tx; this.cfg = props.outbox(); this.json = json;
        handlers.forEach(h -> this.handlers.put(h.topic(), h));
    }

    /** Call inside the transaction of the change itself. */
    public void emit(String tenant, String topic, JsonNode payload) { store.emit(tenant, topic, payload); }

    /** Seconds before attempt n+1: 10, 20, 40 ... capped at an hour. */
    public static long backoffSeconds(int attempts) { return Math.min(3600L, (1L << Math.min(attempts, 20)) * 5L); }

    @Scheduled(fixedDelayString = "${app.outbox.poll-ms:5000}", initialDelayString = "${app.outbox.poll-ms:5000}")
    public void tick() {
        if (!cfg.enabled()) return;
        try { dispatch(cfg.batch()); } catch (RuntimeException e) { log.error("outbox tick failed: {}", e.getMessage()); }
    }

    /** One batch, in one transaction: a failing event is retried or parked, the others are committed. */
    public Result dispatch(int limit) {
        return tx.run(() -> {
            int sent = 0, retried = 0, dead = 0;
            for (OutboxEvent ev : store.lockDue(limit)) {
                try {
                    OutboxTopicHandler h = handlers.get(ev.topic());
                    if (h != null) h.handle(ev);
                    if (cfg.webhookUrl() != null && !cfg.webhookUrl().isBlank()) post(ev);
                    store.markSent(ev.id());
                    sent++;
                } catch (Exception e) {
                    int n = ev.attempts() + 1;
                    String err = String.valueOf(e.getMessage());
                    err = err.length() > 500 ? err.substring(0, 500) : err;
                    if (n >= cfg.maxAttempts()) {
                        store.markDead(ev.id(), n, err);
                        dead++;
                        log.error("outbox event {} ({}) gave up after {} attempts: {}", ev.id(), ev.topic(), n, err);
                    } else {
                        store.markRetry(ev.id(), n, err, backoffSeconds(n));
                        retried++;
                    }
                }
            }
            return new Result(sent, retried, dead);
        });
    }

    private void post(OutboxEvent ev) throws Exception {
        var node = json.createObjectNode();
        node.put("id", ev.id()).put("tenant", ev.tenant()).put("topic", ev.topic()).put("at", ev.createdAt().toString());
        node.set("payload", ev.payload());
        HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(cfg.webhookUrl())).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json").header("Idempotency-Key", "outbox-" + ev.id())
                .POST(HttpRequest.BodyPublishers.ofString(node.toString())).build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() >= 300) throw new IllegalStateException("webhook answered " + res.statusCode());
    }

    public Map<String, Long> counts() { return store.counts(); }
}
