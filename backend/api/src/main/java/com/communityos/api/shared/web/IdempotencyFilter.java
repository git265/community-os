package com.communityos.api.shared.web;

import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.web.util.ContentCachingResponseWrapper;

/**
 * Idempotency for every POST, in one place (after sign-in, so the key is the caller's): the Idempotency-Key header makes a retried POST
 * answer what the first one answered instead of doing it again. Money is never moved without one: a POST that records or moves money
 * (receipts, payment orders, cash book, pay requests, donations, expenses, bills) without a key is refused (428).
 * Left out: sign-in, provider webhooks (they carry their own event ids), the demo, public pages, and file bytes.
 */
public final class IdempotencyFilter implements Filter {
    static final List<String> SKIP = List.of("/api/v1/auth/", "/api/v1/webhooks/", "/api/v1/demo/", "/api/v1/public/", "/api/v1/dev/");
    static final List<String> MONEY = List.of("/api/v1/payments", "/api/v1/payment-orders", "/api/v1/finance/cash-book", "/api/v1/finance/pay-requests",
        "/api/v1/cultural/donations", "/api/v1/cultural/expenses", "/api/v1/dues");
    static final List<String> KEPT_HEADERS = List.of("ETag", "Location", "Content-Type");

    private final Idempotency idempotency;
    public IdempotencyFilter(Idempotency idempotency) { this.idempotency = idempotency; }

    static boolean covered(String method, String path) { return "POST".equals(method) && path.startsWith("/api/v1/") && SKIP.stream().noneMatch(path::startsWith) && !path.equals("/api/v1/files"); }
    /** A POST that creates money records: exactly the collection or a command under it. */
    static boolean money(String path) { return MONEY.stream().anyMatch((m) -> path.equals(m) || path.startsWith(m + "/")); }

    @Override public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) throws IOException, ServletException {
        if (!(req instanceof HttpServletRequest h) || !(res instanceof HttpServletResponse r)) { chain.doFilter(req, res); return; }
        String path = h.getRequestURI().substring(h.getContextPath().length());
        Optional<Caller> caller = CallerHolder.current();
        if (!covered(h.getMethod(), path) || caller.isEmpty()) { chain.doFilter(req, res); return; }
        String key = h.getHeader("Idempotency-Key");
        if (key == null || key.isBlank()) {
            if (money(path)) { problem(r, 428, "idempotency-key-required", "This request moves money: send an Idempotency-Key so a retry cannot do it twice"); return; }
            chain.doFilter(req, res); return;
        }
        byte[] body = h.getInputStream().readAllBytes();                   // already capped by RequestGuardFilter
        Replayable again = new Replayable(h, body);
        Idempotency.Reply reply;
        try {
            reply = idempotency.run(caller.get(), key.strip(), "POST " + path + (h.getQueryString() == null ? "" : "?" + h.getQueryString()), body, () -> {
                ContentCachingResponseWrapper out = new ContentCachingResponseWrapper(r);
                try { chain.doFilter(again, out); } catch (IOException | ServletException e) { throw new Wrapped(e); }
                Map<String, String> kept = new LinkedHashMap<>();
                for (String n : KEPT_HEADERS) { String v = out.getHeader(n); if (v != null) kept.put(n, v); }
                byte[] bytes = out.getContentAsByteArray();
                try { out.copyBodyToResponse(); } catch (IOException e) { throw new Wrapped(e); }
                return new Idempotency.Reply(out.getStatus(), kept, bytes, false);
            });
        } catch (Wrapped w) {
            if (w.getCause() instanceof IOException io) throw io;
            throw (ServletException) w.getCause();
        } catch (DomainException e) {
            problem(r, e instanceof DomainException.Conflict ? 409 : 422, e.code(), e.getMessage()); return;
        }
        if (reply.replayed()) {
            r.setStatus(reply.status());
            reply.headers().forEach(r::setHeader);
            r.setHeader("Idempotent-Replayed", "true");
            if (reply.body() != null) r.getOutputStream().write(reply.body());
        }
    }

    static void problem(HttpServletResponse r, int status, String code, String detail) throws IOException {
        r.setStatus(status); r.setContentType("application/problem+json");
        r.getWriter().write("{\"type\":\"https://communityos.app/problems/" + code + "\",\"status\":" + status + ",\"code\":\"" + code + "\",\"detail\":\""
            + detail.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}");
    }
    private static final class Wrapped extends RuntimeException { private static final long serialVersionUID = 1L; Wrapped(Exception e) { super(e); } }

    /** The request again, with its body read once (to hash it) and given to the controller as if unread. */
    static final class Replayable extends HttpServletRequestWrapper {
        private final byte[] body;
        Replayable(HttpServletRequest r, byte[] body) { super(r); this.body = body; }
        @Override public ServletInputStream getInputStream() {
            ByteArrayInputStream in = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override public int read() { return in.read(); }
                @Override public int read(byte[] b, int off, int len) { return in.read(b, off, len); }
                @Override public boolean isFinished() { return in.available() == 0; }
                @Override public boolean isReady() { return true; }
                @Override public void setReadListener(ReadListener l) { throw new UnsupportedOperationException("not async"); }
            };
        }
        @Override public BufferedReader getReader() {
            String cs = getCharacterEncoding();
            return new BufferedReader(new InputStreamReader(getInputStream(), cs == null ? StandardCharsets.UTF_8 : java.nio.charset.Charset.forName(cs)));
        }
        @Override public long getContentLengthLong() { return body.length; }
    }
}
