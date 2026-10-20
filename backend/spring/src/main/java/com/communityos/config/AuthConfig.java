package com.communityos.config;

import com.communityos.auth.AuthProperties;
import com.communityos.auth.AuthService;
import com.communityos.auth.AuthStore;
import com.communityos.auth.InMemoryAuthStore;
import com.communityos.auth.JdbcAuthStore;
import com.communityos.auth.Tokens;
import com.communityos.port.DocumentRepository;
import com.communityos.port.OutboundChannel;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.HexFormat;
import java.util.List;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Phone sign-in (app.security.mode=local): where its state is kept (same database as the records), the token signer and the service. In the other modes the
 * service still answers GET /api/auth/config ("open"), so the screen knows there is nothing to sign in to.
 */
@Configuration
public class AuthConfig {

    @Bean
    AuthStore authStore(AppProperties p, ObjectProvider<JdbcTemplate> jdbc, ObjectMapper json, Clock clock) {
        return "memory".equals(p.storage().provider()) ? new InMemoryAuthStore(clock) : new JdbcAuthStore(jdbc.getObject(), json);
    }

    @Bean
    AuthService authService(AppProperties p, AuthProperties a, AuthStore store, DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, List<OutboundChannel> channels) {
        boolean local = "local".equals(p.security().mode());
        if (!List.of("sms", "log", "echo").contains(a.otpDelivery())) throw new IllegalStateException("app.auth.otp-delivery must be sms, log or echo.");
        if (!p.payments().allowSimulated() && "echo".equals(a.otpDelivery())) throw new IllegalStateException("app.auth.otp-delivery=echo returns the sign-in code to the screen; not allowed when app.payments.allow-simulated=false.");
        if (!p.payments().allowSimulated() && a.demoRoster()) throw new IllegalStateException("app.auth.demo-roster lets anyone pick a person to sign in as; not allowed when app.payments.allow-simulated=false.");
        OutboundChannel sms = channels.stream().filter((c) -> "SMS".equals(c.channel())).findFirst().orElse(null);
        if (local && "sms".equals(a.otpDelivery()) && sms == null) throw new IllegalStateException("app.auth.otp-delivery=sms needs an SMS channel (app.channels.sms).");
        String secret = a.jwtSecret();
        if (secret == null || secret.isBlank()) {
            if (local) throw new IllegalStateException("Set app.auth.jwt-secret (env JWT_SECRET), at least 32 characters, for app.security.mode=local.");
            byte[] b = new byte[32]; new SecureRandom().nextBytes(b); secret = HexFormat.of().formatHex(b);   // nobody signs in here: a throw-away key
        }
        return new AuthService(a, store, new Tokens(secret, a.issuer(), clock, json), repo, audit, json, clock, sms, p.security().tenantClaim(), local);
    }
}
