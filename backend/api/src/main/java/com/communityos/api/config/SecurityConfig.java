package com.communityos.api.config;

import com.communityos.api.shared.security.CallerJwtConverter;
import com.communityos.api.shared.security.CallerJwtDecoder;
import com.communityos.api.shared.security.CallerLoader;
import com.communityos.api.shared.security.JwtCodec;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * Stateless bearer-token API. Only sign-in, provider webhooks (signature-checked) and health are open; everything else needs a valid ES256
 * access token, which is turned into the server-side Caller. No sessions, no CSRF tokens needed (no cookie authenticates an API call; the
 * refresh cookie is SameSite=Strict and scoped to /api/v1/auth). CORS only for the configured app origins.
 */
@Configuration
public class SecurityConfig {
    @Bean JwtDecoder jwtDecoder(JwtCodec codec) { return new CallerJwtDecoder(codec); }
    @Bean CallerJwtConverter callerJwtConverter(CallerLoader loader) { return new CallerJwtConverter(loader); }

    /** Request id, body limits and the metrics guard: before everything else, sign-in included. */
    @Bean org.springframework.boot.web.servlet.FilterRegistrationBean<com.communityos.api.shared.web.RequestGuardFilter> requestGuardFilter(CosProperties p) {
        var r = new org.springframework.boot.web.servlet.FilterRegistrationBean<>(new com.communityos.api.shared.web.RequestGuardFilter(p.web().metricsToken()));
        r.setName("requestGuard"); r.addUrlPatterns("/*"); r.setOrder(-1000);       // Spring Security's chain is at -100
        return r;
    }

    @Bean SecurityFilterChain api(HttpSecurity http, JwtDecoder decoder, CallerJwtConverter converter, CosProperties p) throws Exception {
        http.csrf((c) -> c.disable())
            .cors((c) -> c.configurationSource(cors(p.web().allowedOrigins())))
            .sessionManagement((s) -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests((a) -> a
                // the second pass of a request that was already allowed (the live stream ending, an error page): not checked again
                .dispatcherTypeMatchers(jakarta.servlet.DispatcherType.ASYNC, jakarta.servlet.DispatcherType.ERROR).permitAll()
                .requestMatchers(HttpMethod.POST, "/api/v1/auth/otp", "/api/v1/auth/token", "/api/v1/auth/refresh", "/api/v1/auth/logout").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/v1/webhooks/*").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/v1/public/**").permitAll()
                .requestMatchers("/api/v1/bridge/**").permitAll()   // a site bridge signs each call with its own token (X-Bridge-Token), checked by the site service
                .requestMatchers("/api/v1/demo/**").permitAll()   // the demo controller exists only with cos.demo.enabled (never in prod): otherwise 404
                // health for the load balancer; the rest of /actuator is guarded by the metrics secret (RequestGuardFilter), not a user's sign-in
                .requestMatchers("/actuator/**", "/v3/api-docs/**", "/swagger-ui/**").permitAll()
                .anyRequest().authenticated())
            .oauth2ResourceServer((o) -> o.jwt((j) -> j.decoder(decoder).jwtAuthenticationConverter(converter)))
            .headers((h) -> h
                .contentTypeOptions(Customizer.withDefaults())
                .frameOptions((f) -> f.deny())
                .httpStrictTransportSecurity((t) -> t.includeSubDomains(true).maxAgeInSeconds(31_536_000))
                .referrerPolicy((r) -> r.policy(ReferrerPolicyHeaderWriter.ReferrerPolicy.NO_REFERRER))
                .contentSecurityPolicy((c) -> c.policyDirectives("default-src 'none'; frame-ancestors 'none'")));
        return http.build();
    }

    private static CorsConfigurationSource cors(List<String> origins) {
        CorsConfiguration c = new CorsConfiguration();
        c.setAllowedOrigins(origins == null ? List.of() : origins);
        c.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE"));
        c.setAllowedHeaders(List.of("Authorization", "Content-Type", "Idempotency-Key", "If-Match", "X-Request-Id"));
        c.setExposedHeaders(List.of("ETag", "Retry-After", "X-Request-Id", "X-List-Truncated"));
        c.setAllowCredentials(true);                               // the refresh cookie
        c.setMaxAge(3600L);
        UrlBasedCorsConfigurationSource s = new UrlBasedCorsConfigurationSource();
        s.registerCorsConfiguration("/api/**", c);
        return s;
    }
}
