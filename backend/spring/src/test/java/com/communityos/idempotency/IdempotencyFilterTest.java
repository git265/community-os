package com.communityos.idempotency;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.communityos.config.AppProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** The Idempotency-Key filter without a servlet container: the request and response are small fakes. */
class IdempotencyFilterTest {
    final Clock clock = Clock.fixed(Instant.parse("2026-10-19T12:00:00Z"), ZoneOffset.UTC);
    final InMemoryIdempotencyStore store = new InMemoryIdempotencyStore(clock);
    final IdempotencyFilter filter = new IdempotencyFilter(store, new AppProperties(null, null, null, null, null, null, null, null, null, new AppProperties.Idempotency(true, 24), null, null), new ObjectMapper());

    static class Out {
        int status = 200; final Map<String, String> headers = new HashMap<>(); final ByteArrayOutputStream body = new ByteArrayOutputStream();
        String text() { return body.toString(StandardCharsets.UTF_8); }
    }

    HttpServletRequest request(String method, String uri, String key, String body) {
        Map<String, String> h = new HashMap<>();
        h.put("X-Community-Id", "la-paloma");
        if (key != null) h.put("Idempotency-Key", key);
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        return (HttpServletRequest) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{HttpServletRequest.class}, (p, m, a) -> switch (m.getName()) {
            case "getHeader" -> h.get(a[0]);
            case "getMethod" -> method;
            case "getRequestURI" -> uri;
            case "getQueryString" -> null;
            case "getCharacterEncoding" -> "UTF-8";
            case "getInputStream" -> {
                ByteArrayInputStream in = new ByteArrayInputStream(bytes);
                yield new ServletInputStream() {
                    public boolean isFinished() { return in.available() == 0; }
                    public boolean isReady() { return true; }
                    public void setReadListener(ReadListener l) { }
                    public int read() { return in.read(); }
                    public int read(byte[] b, int o, int l) { return in.read(b, o, l); }
                };
            }
            default -> null;
        });
    }

    HttpServletResponse response(Out out) {
        return (HttpServletResponse) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{HttpServletResponse.class}, (p, m, a) -> switch (m.getName()) {
            case "setStatus" -> { out.status = (Integer) a[0]; yield null; }
            case "getStatus" -> out.status;
            case "setHeader" -> { out.headers.put((String) a[0], (String) a[1]); yield null; }
            case "getOutputStream" -> new ServletOutputStream() {
                public void write(int b) { out.body.write(b); }
                public boolean isReady() { return true; }
                public void setWriteListener(WriteListener l) { }
            };
            default -> null;
        });
    }

    /** A handler that creates something: answers `status` with `{"made":n}` and counts how often it really ran. */
    FilterChain handler(AtomicInteger runs, int status) {
        return (rq, rs) -> {
            int n = runs.incrementAndGet();
            rq.getInputStream().readAllBytes();   // the body is still readable after the filter hashed it
            ((HttpServletResponse) rs).setStatus(status);
            rs.getOutputStream().write(("{\"made\":" + n + "}").getBytes(StandardCharsets.UTF_8));
        };
    }

    Out call(String key, String body, FilterChain chain) throws java.io.IOException, jakarta.servlet.ServletException {
        Out out = new Out();
        filter.doFilterInternal(request("POST", "/api/payments/orders", key, body), response(out), chain);
        return out;
    }

    @Test
    void aRetryGetsTheOriginalAnswerAndTheWorkRunsOnce() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        Out first = call("key-12345678", "{\"a\":1}", handler(runs, 201));
        assertEquals(201, first.status);
        assertEquals("{\"made\":1}", first.text());
        assertFalse(first.headers.containsKey("Idempotent-Replay"));
        Out again = call("key-12345678", "{\"a\":1}", handler(runs, 201));
        assertEquals(1, runs.get());
        assertEquals(201, again.status);
        assertEquals("{\"made\":1}", again.text());
        assertEquals("true", again.headers.get("Idempotent-Replay"));
    }

    @Test
    void theSameKeyForADifferentRequestIsRefused() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        call("key-12345678", "{\"a\":1}", handler(runs, 200));
        Out other = call("key-12345678", "{\"a\":2}", handler(runs, 200));
        assertEquals(422, other.status);
        assertTrue(other.text().contains("idempotency-mismatch"));
        assertEquals(1, runs.get());
    }

    @Test
    void whileTheFirstAttemptIsStillRunningTheSecondIsToldToWait() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        Out[] inner = new Out[1];
        Out outer = call("key-12345678", "{\"a\":1}", (rq, rs) -> {
            runs.incrementAndGet();
            inner[0] = call("key-12345678", "{\"a\":1}", handler(runs, 200));
            ((HttpServletResponse) rs).setStatus(200);
        });
        assertEquals(409, inner[0].status);
        assertTrue(inner[0].text().contains("in-flight"));
        assertEquals(1, runs.get());
        assertEquals(200, outer.status);
    }

    @Test
    void aServerErrorIsNotRememberedSoTheRetryRunsForReal() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        assertEquals(500, call("key-12345678", "{}", handler(runs, 500)).status);
        assertEquals(200, call("key-12345678", "{}", handler(runs, 200)).status);
        assertEquals(2, runs.get());
        assertEquals("true", call("key-12345678", "{}", handler(runs, 200)).headers.get("Idempotent-Replay"));
        assertEquals(2, runs.get());
    }

    @Test
    void anExceptionReleasesTheKey() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        assertThrows(IllegalStateException.class, () -> call("key-12345678", "{}", (rq, rs) -> { runs.incrementAndGet(); throw new IllegalStateException("boom"); }));
        assertEquals(200, call("key-12345678", "{}", handler(runs, 200)).status);
        assertEquals(2, runs.get());
    }

    @Test
    void aMalformedKeyIsRefusedAndOnlyWritesWithAKeyAreCovered() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        assertEquals(400, call("short", "{}", handler(runs, 200)).status);
        assertEquals(0, runs.get());
        assertFalse(filter.shouldNotFilter(request("POST", "/api/dues/d1", "key-12345678", "")));
        assertTrue(filter.shouldNotFilter(request("GET", "/api/dues/d1", "key-12345678", "")));
        assertTrue(filter.shouldNotFilter(request("POST", "/api/dues/d1", null, "")));
        assertTrue(filter.shouldNotFilter(request("PUT", "/api/files/f1/content", "key-12345678", "")));
        assertTrue(filter.shouldNotFilter(request("POST", "/api/payments/webhook/simulated", "key-12345678", "")));
    }

    @Test
    void keysBelongToOneCommunityAndKeysOlderThanTheLimitAreForgotten() throws Exception {
        assertTrue(store.begin("a", "-", "key-12345678", "h"));
        assertFalse(store.begin("a", "-", "key-12345678", "h"));
        assertTrue(store.begin("b", "-", "key-12345678", "h"));
        assertEquals(0, store.cleanup(24));
        assertTrue(store.find("a", "-", "key-12345678").isPresent());
        store.release("a", "-", "key-12345678");
        assertFalse(store.find("a", "-", "key-12345678").isPresent());
    }
}
