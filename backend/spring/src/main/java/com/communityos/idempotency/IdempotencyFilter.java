package com.communityos.idempotency;

import com.communityos.config.AppProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

/**
 * Idempotency-Key for every write: a retry (network timeout, double tap, proxy replay) gets the ORIGINAL answer and does not do the work twice.
 *   same key + same request  -> the stored response is replayed (header Idempotent-Replay: true)
 *   same key + other request -> 422 (a key may only ever mean one request)
 *   same key while the first is still running -> 409 (try again shortly)
 * A key belongs to one community and one signed-in person. A 5xx or 429 is not remembered, so the retry runs for real. Keys live app.idempotency.hours.
 * Runs after the security filter chain, so the caller is known. File bytes and the provider webhook are not covered (the webhook has its own event ids).
 */
@Component
public class IdempotencyFilter extends OncePerRequestFilter {
    private static final Pattern KEY_OK = Pattern.compile("^[A-Za-z0-9_.:-]{8,100}$");
    private static final Set<String> METHODS = Set.of("POST", "PUT", "DELETE", "PATCH");

    private final IdempotencyStore store;
    private final AppProperties.Idempotency cfg;
    private final ObjectMapper json;

    public IdempotencyFilter(IdempotencyStore store, AppProperties props, ObjectMapper json) { this.store = store; this.cfg = props.idempotency(); this.json = json; }

    @Override protected boolean shouldNotFilter(HttpServletRequest req) {
        String path = req.getRequestURI();
        return !cfg.enabled() || req.getHeader("Idempotency-Key") == null || !METHODS.contains(req.getMethod()) || !path.startsWith("/api/")
                || path.endsWith("/content") || path.startsWith("/api/payments/webhook/") || req.getHeader("X-Community-Id") == null;
    }

    @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String key = req.getHeader("Idempotency-Key");
        if (!KEY_OK.matcher(key).matches()) { send(res, 400, "Idempotency-Key must be 8-100 letters, digits or _ . : -", "bad-idempotency-key"); return; }
        String tenant = req.getHeader("X-Community-Id").trim().toLowerCase();
        String scope = scopeOf();
        byte[] body = req.getInputStream().readAllBytes();
        String hash = hash(req, body);

        if (!store.begin(tenant, scope, key, hash)) {
            var seen = store.find(tenant, scope, key);
            if (seen.isPresent()) {
                var e = seen.get();
                if (!e.requestHash().equals(hash)) { send(res, 422, "This Idempotency-Key was already used for a different request.", "idempotency-mismatch"); return; }
                if (!e.done()) { send(res, 409, "The first attempt of this request is still running. Try again in a moment.", "in-flight"); return; }
                res.setHeader("Idempotent-Replay", "true");
                res.setStatus(e.status() == null ? 200 : e.status());
                res.setContentType("application/json");
                res.setCharacterEncoding("UTF-8");
                if (e.body() != null) res.getOutputStream().write(e.body().getBytes(StandardCharsets.UTF_8));
                return;
            }
            // expired between the two statements: treat as new (the begin below may lose a race; then the work simply runs unprotected once)
            store.begin(tenant, scope, key, hash);
        }

        ContentCachingResponseWrapper wrapped = new ContentCachingResponseWrapper(res);
        try {
            chain.doFilter(new CachedBodyRequest(req, body), wrapped);
            int status = wrapped.getStatus();
            if (status < 500 && status != 429) store.complete(tenant, scope, key, status, new String(wrapped.getContentAsByteArray(), StandardCharsets.UTF_8));
            else store.release(tenant, scope, key);
        } catch (IOException | ServletException | RuntimeException e) {
            store.release(tenant, scope, key);   // the caller answers the error; let a retry try again
            throw e;
        } finally {
            wrapped.copyBodyToResponse();
        }
    }

    private static String scopeOf() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a == null || a instanceof AnonymousAuthenticationToken || a.getName() == null) return "-";
        return a.getName();
    }

    private static String hash(HttpServletRequest req, byte[] body) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update((req.getMethod() + " " + req.getRequestURI() + (req.getQueryString() == null ? "" : "?" + req.getQueryString()) + "\n").getBytes(StandardCharsets.UTF_8));
            md.update(body);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    private void send(HttpServletResponse res, int status, String message, String code) throws IOException {
        res.setStatus(status);
        res.setContentType("application/json");
        res.setCharacterEncoding("UTF-8");
        res.getOutputStream().write(json.writeValueAsBytes(Map.of("message", message, "code", code)));
    }
}
