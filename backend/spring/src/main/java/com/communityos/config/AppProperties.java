package com.communityos.config;

import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** Everything under `app:` in application.yml - the ONLY place vendor choices and secrets are read. */
@ConfigurationProperties(prefix = "app")
public record AppProperties(
        @DefaultValue Storage storage,
        @DefaultValue Files files,
        @DefaultValue Channels channels,
        @DefaultValue Payments payments,
        @DefaultValue Gst gst,
        @DefaultValue Security security,
        @DefaultValue Cors cors,
        @DefaultValue Admin admin,
        @DefaultValue Outbox outbox,
        @DefaultValue Idempotency idempotency,
        @DefaultValue Evoting evoting,
        @DefaultValue Jobs jobs) {

    public record Storage(@DefaultValue("postgres") String provider,
                          @DefaultValue("communities") List<String> platformCollections,
                          @DefaultValue("true") boolean typedTables) {}

    public record Files(@DefaultValue("local") String provider,
                        @DefaultValue("./data/files") String localDir,
                        @DefaultValue S3 s3) {
        public record S3(String bucket, @DefaultValue("ap-south-1") String region, String endpoint,
                         @DefaultValue("false") boolean pathStyle, String accessKey, String secretKey,
                         @DefaultValue("communityos/") String prefix) {}
    }

    public record Channels(@DefaultValue Email email, @DefaultValue Http sms, @DefaultValue Http whatsapp,
                           @DefaultValue("notificationOutbox") String outboxCollection,
                           @DefaultValue("30000") long pollMs,
                           @DefaultValue("false") boolean enabled) {
        public record Email(@DefaultValue("log") String provider, @DefaultValue("no-reply@example.com") String from) {}
        public record Http(@DefaultValue("log") String provider, @DefaultValue HttpTarget http) {}
        public record HttpTarget(String url, @DefaultValue("POST") String method, String authHeader,
                                 @DefaultValue("{\"to\":\"{to}\",\"text\":\"{text}\"}") String bodyTemplate) {}
    }

    /**
     * @param orderMinutes          an order nobody paid is expired after this long
     * @param reconcileSeconds      how often the reconcile job looks for orders a lost webhook left open (0 = off)
     * @param pendingRecheckSeconds an open order is asked about at most this often
     * @param allowSimulated        false in production: refuses to start with the pretend bank or the default webhook secret
     * @param breakerTimeoutMs      a call to the provider's status API is cut off after this long
     * @param breakerFailures       this many failures in a row open the breaker: calls then fail at once for breakerResetMs
     */
    public record Payments(@DefaultValue("simulated") String provider,
                           @DefaultValue("dev-secret") String webhookSecret,
                           @DefaultValue("30") int orderMinutes,
                           @DefaultValue("30") int reconcileSeconds,
                           @DefaultValue("20") int pendingRecheckSeconds,
                           @DefaultValue("true") boolean allowSimulated,
                           @DefaultValue("8000") long breakerTimeoutMs,
                           @DefaultValue("5") int breakerFailures,
                           @DefaultValue("30000") long breakerResetMs) {}

    public record Gst(@DefaultValue("simulated") String provider) {}

    /**
     * @param userMatch      how a sign-in (OpenID Connect) is matched to a `users` record, in order: subject (authSubject = the token's sub), phone, email
     * @param unportedHooks  `refuse` (default): a write that the Node server would run extra checks on (money, e-voting, bookings ...) and that Spring
     *                       cannot check yet is refused; `allow`: it goes ahead WITHOUT those checks (logged as a warning). See docs/BACKEND.md section 10.
     * @param metaTtlMs      0 (default): a community's roles, field rules and approver settings are read fresh for every request; above 0: kept that many ms
     */
    public record Security(@DefaultValue("none") String mode, String apiKey,
                           @DefaultValue("community") String tenantClaim,
                           @DefaultValue("subject,phone,email") String userMatch,
                           @DefaultValue("refuse") String unportedHooks,
                           @DefaultValue("0") long metaTtlMs) {}

    public record Cors(@DefaultValue("http://localhost:5173") List<String> allowedOrigins) {}

    /** The event outbox worker. One instance is enough; several are safe (rows are taken with SKIP LOCKED). */
    public record Outbox(@DefaultValue("true") boolean enabled, @DefaultValue("5000") long pollMs, @DefaultValue("8") int maxAttempts,
                         @DefaultValue("50") int batch, String webhookUrl) {}

    /** Idempotency-Key on writes: how long a key is remembered. */
    public record Idempotency(@DefaultValue("true") boolean enabled, @DefaultValue("24") int hours) {}

    /** E-voting second factor: how the one-time code reaches the owner. `sms` (production), `log` (the code is printed in the server log), `echo` (the code is returned to the screen: demo only). */
    public record Evoting(@DefaultValue("log") String delivery) {}

    /**
     * The scheduled amenity work (release unpaid bookings, complete past ones, reminders, reports).
     * @param intervalSeconds how often it runs (0 = off); safe to run often, every step is idempotent
     */
    public record Jobs(@DefaultValue("300") int intervalSeconds) {}

    public record Admin(@DefaultValue("false") boolean allowTenantReset) {}
}
