package com.communityos.api.config;

import com.communityos.api.identity.adapter.HttpSmsOtpSender;
import com.communityos.api.identity.adapter.JdbcCommunityDirectory;
import com.communityos.api.identity.adapter.JdbcCallerLoader;
import com.communityos.api.identity.adapter.JdbcMemberRepository;
import com.communityos.api.identity.adapter.JdbcOtpStore;
import com.communityos.api.identity.adapter.JdbcPersonDirectory;
import com.communityos.api.identity.adapter.JdbcRateLimiter;
import com.communityos.api.identity.adapter.JdbcRefreshTokenStore;
import com.communityos.api.identity.adapter.JdbcRoleCatalog;
import com.communityos.api.identity.adapter.JwtTokenIssuer;
import com.communityos.api.identity.adapter.LogOtpSender;
import com.communityos.api.identity.application.AuthService;
import com.communityos.api.identity.application.CodeHasher;
import com.communityos.api.identity.application.MemberService;
import com.communityos.api.identity.application.port.OtpSender;
import com.communityos.api.identity.application.port.PersonDirectory;
import com.communityos.api.identity.application.port.RefreshTokenStore;
import com.communityos.api.identity.application.port.RoleCatalog;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.http.HttpTransport;
import com.communityos.api.shared.resilience.CircuitBreaker;
import com.communityos.api.shared.resilience.Resilient;
import com.communityos.api.shared.resilience.RetryPolicy;
import com.communityos.api.shared.security.CallerLoader;
import com.communityos.api.shared.security.JwtCodec;
import com.communityos.api.shared.tx.Tx;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Identity module wiring: keys, token issuing, sign-in, the caller loader and member management. */
@Configuration
public class AuthConfig {
    @Bean JwtCodec jwtCodec(CosProperties p, Environment env, Clock clock) {
        return new JwtCodec(SigningKeys.load(p.auth(), env.matchesProfiles("prod")), p.auth().issuer(), p.auth().audience(), clock);
    }
    @Bean JwtTokenIssuer tokenIssuer(JwtCodec codec, CosProperties p, Clock clock) { return new JwtTokenIssuer(codec, p.auth().accessTtl(), clock); }

    @Bean PersonDirectory personDirectory(@Qualifier("platform") NamedParameterJdbcTemplate platformJdbc) { return new JdbcPersonDirectory(platformJdbc); }
    @Bean RefreshTokenStore refreshTokenStore(@Qualifier("platform") NamedParameterJdbcTemplate platformJdbc) { return new JdbcRefreshTokenStore(platformJdbc); }
    @Bean CallerLoader callerLoader(@Qualifier("platform") NamedParameterJdbcTemplate platformJdbc, CosProperties p, Clock clock) {
        return new JdbcCallerLoader(platformJdbc, p.auth().callerCacheTtl(), clock);
    }

    /** Strategy chosen by configuration: "log" (development) or "sms" (a provider's HTTP API, resilient). */
    @Bean OtpSender otpSender(CosProperties p, Environment env, HttpTransport http, ObjectMapper json, Clock clock) {
        if ("sms".equals(p.auth().otpSender())) {
            CosProperties.Sms s = p.auth().sms();
            Resilient r = new Resilient(Duration.ofSeconds(3), new CircuitBreaker("sms", 5, Duration.ofSeconds(30), clock), RetryPolicy.transientFailures(2));
            return new HttpSmsOtpSender(http, r, new HttpSmsOtpSender.Settings(URI.create(s.endpoint()), s.apiKey(), s.templateId(), s.senderId()), json);
        }
        if (env.matchesProfiles("prod")) throw new IllegalStateException("cos.auth.otp-sender=log is not allowed in prod");
        return new LogOtpSender();
    }

    @Bean AuthService authService(@Qualifier("platform") NamedParameterJdbcTemplate platformJdbc, RefreshTokenStore refreshTokens, PersonDirectory people, OtpSender sender,
                                  JwtTokenIssuer issuer, @Qualifier("platform") Tx platformTx, Clock clock, CosProperties p) {
        AuthService.Settings d = AuthService.Settings.defaults();
        AuthService.Settings s = new AuthService.Settings(p.auth().defaultCountryCode(), d.codeTtl(), d.maxAttempts(), p.auth().refreshTtl(), d.codesPerPhone(), d.requestsPerIp(), d.window());
        return new AuthService(new JdbcOtpStore(platformJdbc), refreshTokens, people, sender, new JdbcRateLimiter(platformJdbc), issuer, new CodeHasher(p.auth().otpPepper()),
            platformTx, clock, s);
    }

    @Bean RoleCatalog roleCatalog(NamedParameterJdbcTemplate jdbc) { return new JdbcRoleCatalog(jdbc); }
    @Bean JdbcCommunityDirectory communityDirectory(@Qualifier("platform") NamedParameterJdbcTemplate platformJdbc) { return new JdbcCommunityDirectory(platformJdbc); }

    @Bean MemberService memberService(NamedParameterJdbcTemplate jdbc, ObjectMapper json, PersonDirectory people, RefreshTokenStore refreshTokens, CallerLoader callers,
                                      RoleCatalog roles, AuditWriter audit, Tx tx, Clock clock, CosProperties p) {
        return new MemberService(new JdbcMemberRepository(jdbc, json), roles, people, refreshTokens, callers, audit, tx, clock, p.auth().defaultCountryCode());
    }
}
