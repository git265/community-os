package com.communityos.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Phone sign-in with one-time codes (app.security.mode=local): the server sends and checks the codes and issues its own tokens. The same settings as the
 * Node server's AUTH_* / OTP_* variables (backend/contract-server/auth.mjs).
 *
 * @param otpDelivery  sms: the code goes out through the SMS channel (app.channels.sms) | log: printed in the server log | echo: returned to the screen
 *                     (a demo only: refused at start-up when app.payments.allow-simulated=false, as is the demo roster)
 * @param jwtSecret    the HS256 key of the access tokens (at least 32 characters). Required in local mode; one per deployment, shared by all its servers
 * @param trustProxy   believe X-Forwarded-For for the caller's address (the rate limit per network) only behind a proxy you run
 */
@ConfigurationProperties(prefix = "app.auth")
public record AuthProperties(
        @DefaultValue("log") String otpDelivery,
        @DefaultValue("15") int accessTokenMinutes,
        @DefaultValue("7") int refreshTokenDays,
        @DefaultValue("5") int otpMinutes,
        @DefaultValue("3") int otpTries,
        @DefaultValue("20") int resendSeconds,
        @DefaultValue("5") int codesPerPhoneHour,
        @DefaultValue("30") int codesPerIpHour,
        @DefaultValue("5") int lockAfterFailures,
        @DefaultValue("15") int lockMinutes,
        @DefaultValue("communityos") String issuer,
        String jwtSecret,
        @DefaultValue("false") boolean demoRoster,
        @DefaultValue("false") boolean secureCookie,
        @DefaultValue("false") boolean trustProxy) {

    /** The defaults, for tests. */
    public static AuthProperties defaults(String secret) { return new AuthProperties("echo", 15, 7, 5, 3, 20, 5, 30, 5, 15, "communityos", secret, false, false, false); }
}
