package com.communityos.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Authentication is a setting (app.security.mode):
 *   none     open API - local development only
 *   api-key  one shared key in "Authorization: Bearer <key>" - internal tools and the UI's dev "Access key" box
 *   jwt      real sign-in with ANY OpenID Connect provider (profile `jwt`, see application-jwt.yml)
 *   local    phone sign-in with one-time codes on THIS server (/api/auth/*, com.communityos.auth): it issues HS256 tokens (app.auth.jwt-secret)
 *            and checks them on every call; the session behind a token must still be live
 * The webhook, /api/health and the sign-in endpoints stay open (the webhook proves itself with a signature).
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain chain(HttpSecurity http, AppProperties props, com.communityos.auth.AuthService auth, com.fasterxml.jackson.databind.ObjectMapper json,
                              @org.springframework.beans.factory.annotation.Value("${springdoc.api-docs.enabled:true}") boolean docsOpen) throws Exception {
        String mode = props.security().mode();
        http.csrf(c -> c.disable())
            .cors(Customizer.withDefaults())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(a -> {
                a.requestMatchers(HttpMethod.OPTIONS, "/**").permitAll();
                a.requestMatchers("/api/health", "/api/payments/webhook/**", "/actuator/health").permitAll();
                a.requestMatchers("/api/auth/**").permitAll();   // how one signs in; /me and /switch-role check the token themselves
                a.requestMatchers("/api/platform/**").permitAll();   // the platform console: PlatformController checks the X-Platform-Key header itself
                if (docsOpen) a.requestMatchers("/swagger-ui.html", "/swagger-ui/**", "/v3/api-docs/**").permitAll();   // the docs describe the API; they hold no data
                if ("none".equals(mode)) a.anyRequest().permitAll(); else a.anyRequest().authenticated();
            });
        switch (mode) {
            case "jwt" -> http.oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()));
            case "api-key" -> {
                if (props.security().apiKey() == null || props.security().apiKey().isBlank()) throw new IllegalStateException("app.security.api-key (env API_KEY) must be set in api-key mode.");
                http.addFilterBefore(new ApiKeyFilter(props.security().apiKey()), AnonymousAuthenticationFilter.class);
            }
            case "local" -> http.addFilterBefore(new LocalTokenFilter(auth, json), AnonymousAuthenticationFilter.class);
            case "none" -> { }
            default -> throw new IllegalStateException("Unknown app.security.mode: " + mode);
        }
        return http.build();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource(AppProperties props) {
        CorsConfiguration c = new CorsConfiguration();
        c.setAllowedOrigins(props.cors().allowedOrigins());
        c.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        c.setAllowedHeaders(List.of("Content-Type", "Authorization", "X-Community-Id", "X-Platform-Key", "Idempotency-Key", "X-Request-Id", "If-Match"));
        UrlBasedCorsConfigurationSource src = new UrlBasedCorsConfigurationSource();
        src.registerCorsConfiguration("/api/**", c);
        return src;
    }

    /**
     * Local sign-in: a Bearer token is checked (signature, issuer, expiry) before anything else reads the request. A bad or expired token is answered here
     * with 401 and its code ("expired"), which tells the screen to refresh; a request without a token goes on unauthenticated (the open paths still work).
     */
    static class LocalTokenFilter extends OncePerRequestFilter {
        private final com.communityos.auth.AuthService auth;
        private final com.fasterxml.jackson.databind.ObjectMapper json;
        LocalTokenFilter(com.communityos.auth.AuthService auth, com.fasterxml.jackson.databind.ObjectMapper json) { this.auth = auth; this.json = json; }

        @Override
        protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
            String h = req.getHeader("Authorization");
            if (h != null && h.startsWith("Bearer ")) {
                try {
                    SecurityContextHolder.getContext().setAuthentication(new com.communityos.auth.LocalAuthentication(auth.claims(h.substring(7))));
                } catch (com.communityos.auth.AuthException e) {
                    if (!req.getRequestURI().startsWith("/api/auth/")) {   // the sign-in endpoints work without a (valid) token
                        res.setStatus(e.status());
                        res.setContentType("application/json");
                        com.fasterxml.jackson.databind.node.ObjectNode body = json.createObjectNode().put("message", e.getMessage());
                        if (e.code() != null) body.put("code", e.code());
                        res.getWriter().write(body.toString());
                        return;
                    }
                }
            }
            chain.doFilter(req, res);
        }
    }

    /** Constant-time check of the shared key. */
    static class ApiKeyFilter extends OncePerRequestFilter {
        private final byte[] key;
        ApiKeyFilter(String key) { this.key = key.getBytes(StandardCharsets.UTF_8); }

        @Override
        protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
            String h = req.getHeader("Authorization");
            if (h != null && h.startsWith("Bearer ") && MessageDigest.isEqual(key, h.substring(7).getBytes(StandardCharsets.UTF_8))) {
                SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken("api-key", null, List.of()));
            }
            chain.doFilter(req, res);
        }
    }
}
