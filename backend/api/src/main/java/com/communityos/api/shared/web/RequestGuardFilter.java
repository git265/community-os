package com.communityos.api.shared.web;

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
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.MDC;

/**
 * The first thing every request meets (before sign-in is looked at):
 *   request id   the caller's X-Request-Id when it is a plain token, else a new one; echoed back, put in the log context (MDC "requestId"),
 *                which the audit writer records, so one id ties the client's report, the log lines and the audit rows together
 *   body limit   a body is never read past its limit (413): files 26 MB, a site plan 13 MB, a bridge's punches 8 MB, a provider webhook 256 KB, anything else 2 MB -
 *                checked on Content-Length and again while the bytes are read (a chunked body has no length)
 *   metrics      /actuator/* other than health needs the scraper's basic-auth secret (COS_METRICS_TOKEN); with none set it is not there (404)
 */
public final class RequestGuardFilter implements Filter {
    public static final String REQUEST_ID = "requestId";
    static final Pattern GOOD_ID = Pattern.compile("[A-Za-z0-9._:-]{8,64}");
    static final long MB = 1024L * 1024;

    private final byte[] metricsSecret;
    public RequestGuardFilter(String metricsToken) {
        this.metricsSecret = metricsToken == null || metricsToken.isBlank() ? null : ("metrics:" + metricsToken.strip()).getBytes(StandardCharsets.UTF_8);
    }

    /** The most a request to this path may send. */
    static long limitFor(String method, String path) {
        if (path.startsWith("/api/v1/webhooks/")) return 256 * 1024;
        if ("POST".equals(method) && path.equals("/api/v1/files")) return 26 * MB;
        if (path.startsWith("/api/v1/assets/site-plans")) return 13 * MB;
        if ("POST".equals(method) && path.equals("/api/v1/bridge/events")) return 8 * MB;
        return 2 * MB;
    }

    @Override public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) throws IOException, ServletException {
        if (!(req instanceof HttpServletRequest h) || !(res instanceof HttpServletResponse r)) { chain.doFilter(req, res); return; }
        String given = h.getHeader("X-Request-Id");
        String id = given != null && GOOD_ID.matcher(given).matches() ? given : UUID.randomUUID().toString();
        MDC.put(REQUEST_ID, id);
        r.setHeader("X-Request-Id", id);
        try {
            String path = h.getRequestURI().substring(h.getContextPath().length());
            if (path.startsWith("/actuator/") && !path.startsWith("/actuator/health") && !metricsAllowed(h)) {
                if (metricsSecret == null) { r.sendError(404); return; }
                r.setHeader("WWW-Authenticate", "Basic realm=\"metrics\""); r.sendError(401); return;
            }
            long limit = limitFor(h.getMethod(), path);
            long declared = h.getContentLengthLong();
            if (declared > limit) { tooLarge(r, limit); return; }
            chain.doFilter(declared >= 0 ? h : new Capped(h, limit), res);
        } finally { MDC.remove(REQUEST_ID); }
    }

    private boolean metricsAllowed(HttpServletRequest h) {
        if (metricsSecret == null) return false;
        String a = h.getHeader("Authorization");
        if (a == null || !a.regionMatches(true, 0, "Basic ", 0, 6)) return false;
        byte[] given;
        try { given = Base64.getDecoder().decode(a.substring(6).strip()); } catch (IllegalArgumentException e) { return false; }
        return MessageDigest.isEqual(metricsSecret, given);
    }
    static void tooLarge(HttpServletResponse r, long limit) throws IOException {
        r.setStatus(413); r.setContentType("application/problem+json");
        r.getWriter().write("{\"type\":\"https://communityos.app/problems/too-large\",\"title\":\"Payload Too Large\",\"status\":413,\"code\":\"too-large\",\"detail\":\"The request is larger than "
            + (limit >= MB ? limit / MB + " MB" : limit / 1024 + " KB") + "\"}");
    }

    /** A body without a length: refused (as too large) the moment it passes its limit, without reading the rest. */
    static final class Capped extends HttpServletRequestWrapper {
        private final long limit;
        Capped(HttpServletRequest r, long limit) { super(r); this.limit = limit; }
        @Override public ServletInputStream getInputStream() throws IOException {
            ServletInputStream in = super.getInputStream();
            return new ServletInputStream() {
                long seen;
                private void count(long n) throws IOException { if (n > 0 && (seen += n) > limit) throw new PayloadTooLarge(limit); }
                @Override public int read() throws IOException { int b = in.read(); if (b >= 0) count(1); return b; }
                @Override public int read(byte[] buf, int off, int len) throws IOException { int n = in.read(buf, off, len); count(n); return n; }
                @Override public boolean isFinished() { return in.isFinished(); }
                @Override public boolean isReady() { return in.isReady(); }
                @Override public void setReadListener(ReadListener l) { in.setReadListener(l); }
            };
        }
        @Override public BufferedReader getReader() throws IOException {
            String cs = getCharacterEncoding();
            return new BufferedReader(new InputStreamReader(getInputStream(), cs == null ? StandardCharsets.UTF_8 : java.nio.charset.Charset.forName(cs)));
        }
    }
    /** Thrown while reading a body that went past its limit (ProblemHandler answers 413). */
    public static final class PayloadTooLarge extends IOException {
        private static final long serialVersionUID = 1L;
        public final long limit;
        public PayloadTooLarge(long limit) { super("The request is larger than allowed"); this.limit = limit; }
    }
}
