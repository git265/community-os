package com.communityos.api.shared.integration;

import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.http.HttpTransport;
import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.shared.resilience.RetryPolicy;
import com.communityos.api.shared.resilience.TransientFailure;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * Delivers webhook rows: POST the event JSON with
 *   X-CommunityOS-Event-Id   (receivers de-duplicate on it)
 *   X-CommunityOS-Timestamp  (receivers refuse anything older than 5 minutes: no replay)
 *   X-CommunityOS-Signature  v1=HMAC_SHA256(secret, timestamp + "." + body)
 * 2xx = Delivered; 5xx / 429 / timeout = retried with jittered exponential backoff up to 12 times (about a day); other 4xx = Dead.
 */
public final class WebhookDeliveryWorker {
    record Due(long id, UUID eventId, String url, String secretRef, String topic, String payload, int attempts) {}
    static final String CLAIM = """
        UPDATE integration.webhook_delivery d SET next_attempt_at = now() + interval '2 minutes'
        FROM integration.webhook_subscription s, integration.outbox_event e
        WHERE d.id IN (SELECT id FROM integration.webhook_delivery WHERE status = 'Pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT :batch FOR UPDATE SKIP LOCKED)
          AND s.community_id = d.community_id AND s.id = d.subscription_id AND e.event_id = d.event_id
        RETURNING d.id, d.event_id, s.url, s.secret_ref, e.topic, e.payload::text AS payload, d.attempts""";
    static final String DONE = "UPDATE integration.webhook_delivery SET status = 'Delivered', attempts = :attempts, response_status = :status, last_error = NULL WHERE id = :id";
    static final String RETRY = "UPDATE integration.webhook_delivery SET attempts = :attempts, response_status = :status, last_error = left(:error, 500), next_attempt_at = CAST(:next AS timestamptz) WHERE id = :id";
    static final String DEAD = "UPDATE integration.webhook_delivery SET status = 'Dead', attempts = :attempts, response_status = :status, last_error = left(:error, 500) WHERE id = :id";
    private static final int MAX_ATTEMPTS = 12;

    private final NamedParameterJdbcTemplate jdbc; private final HttpTransport http; private final SecretResolver secrets; private final Clock clock;
    private final RetryPolicy backoff = new RetryPolicy(MAX_ATTEMPTS, Duration.ofSeconds(30), Duration.ofHours(6), TransientFailure::is);

    public WebhookDeliveryWorker(NamedParameterJdbcTemplate platformJdbc, HttpTransport http, SecretResolver secrets, Clock clock) {
        this.jdbc = platformJdbc; this.http = http; this.secrets = secrets; this.clock = clock;
    }

    public int runOnce(int batch) {
        List<Due> due = jdbc.query(CLAIM, Map.of("batch", batch), (rs, i) -> new Due(rs.getLong("id"), Rows.uuid(rs, "event_id"), rs.getString("url"), rs.getString("secret_ref"),
            rs.getString("topic"), rs.getString("payload"), rs.getInt("attempts")));
        int ok = 0;
        for (Due d : due) {
            int attempts = d.attempts() + 1;
            int status = 0; String error;
            try {
                String ts = String.valueOf(clock.instant().getEpochSecond());
                byte[] body = Crypto.utf8(d.payload());
                HttpTransport.Response r = http.send(HttpTransport.Request.post(URI.create(d.url()), body).timeout(Duration.ofSeconds(10))
                    .header("X-CommunityOS-Event-Id", d.eventId().toString()).header("X-CommunityOS-Topic", d.topic()).header("X-CommunityOS-Timestamp", ts)
                    .header("X-CommunityOS-Signature", "v1=" + Crypto.hmacHex(secrets.resolve(d.secretRef()), ts + "." + d.payload())));
                status = r.status();
                if (status >= 200 && status < 300) { jdbc.update(DONE, Map.of("id", d.id(), "attempts", attempts, "status", status)); ok++; continue; }
                error = "HTTP " + status;
                if (status < 500 && status != 429 && status != 408) { jdbc.update(DEAD, Map.of("id", d.id(), "attempts", attempts, "status", status, "error", error)); continue; }
            } catch (RuntimeException e) { error = e.getClass().getSimpleName() + ": " + e.getMessage(); }
            if (attempts >= MAX_ATTEMPTS) jdbc.update(DEAD, Map.of("id", d.id(), "attempts", attempts, "status", status, "error", error));
            else jdbc.update(RETRY, Map.of("id", d.id(), "attempts", attempts, "status", status, "error", error, "next", Rows.ts(clock.instant().plus(backoff.backoff(attempts)).plusSeconds(30))));
        }
        return ok;
    }
}
