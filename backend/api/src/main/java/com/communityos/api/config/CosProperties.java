package com.communityos.api.config;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** Everything configurable, bound from application.yml / environment (secrets come from the environment or a secret manager, never the repo). */
@ConfigurationProperties("cos")
public record CosProperties(Db db, Auth auth, Payments payments, Web web, @DefaultValue Files files, @DefaultValue Demo demo, @DefaultValue Channels channels) {

    /** Two pools: the API role (row-level security applies) and the platform role (sign-in, webhooks, cross-community jobs). */
    public record Db(Pool app, Pool platform) {}
    public record Pool(String url, String username, String password, @DefaultValue("20") int maxPoolSize, @DefaultValue("3s") Duration connectionTimeout,
                       @DefaultValue("15s") Duration statementTimeout) {}

    public record Auth(@DefaultValue("https://api.communityos.app") String issuer, @DefaultValue("communityos-app") String audience,
                       @DefaultValue("10m") Duration accessTtl, @DefaultValue("30d") Duration refreshTtl, @DefaultValue("30s") Duration callerCacheTtl,
                       String otpPepper, @DefaultValue("log") String otpSender, @DefaultValue("+91") String defaultCountryCode,
                       /* PKCS#8 PEM of the EC P-256 signing key, and its key id */
                       String signingKeyPem, @DefaultValue("k1") String keyId,
                       /* older public keys (kid -> X.509 PEM) still accepted during a key rotation */
                       Map<String, String> previousKeys,
                       /* development only: generate a throw-away signing key at start-up when none is configured */
                       @DefaultValue("false") boolean allowEphemeralKey,
                       Sms sms) {}
    public record Sms(String endpoint, String apiKey, String templateId, String senderId) {}

    public record Payments(@DefaultValue("simulated") String defaultProvider, @DefaultValue("30m") Duration orderTtl, @DefaultValue("INR") String currency,
                           Simulated simulated, Razorpay razorpay) {}
    public record Simulated(@DefaultValue("false") boolean enabled, String secret) {}
    public record Razorpay(@DefaultValue("false") boolean enabled, @DefaultValue("https://api.razorpay.com") String baseUrl, String keyId, String keySecret, String webhookSecret) {}

    public record Web(List<String> allowedOrigins, @DefaultValue("Asia/Kolkata") String timeZone) {}
    /** Where uploaded files' bytes are kept (a folder on this server; an object store adapter replaces it in production), and the virus scanner:
     *  none (files stay "Pending", not scanned) or simulated (development only: finds the EICAR test file, calls the rest clean). */
    public record Files(@DefaultValue("./var/files") String dir, @DefaultValue("none") String scanner) {}
    /** Who sends the WhatsApp / SMS / e-mail copies of notifications: none (they stay Queued, nothing leaves the server) or simulated
     *  (development only: written to the log and marked Sent). A real provider adapter plugs in behind comms.application.port.ChannelSender. */
    public record Channels(@DefaultValue("none") String provider) {}
    /** Development and demos only (refused in prod): load the La Paloma demo into a community and sign in as anyone on its roster without a code. */
    public record Demo(@DefaultValue("false") boolean enabled) {}
}
