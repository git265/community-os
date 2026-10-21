package com.communityos.api.shared.http;

import java.net.URI;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/** Port for outbound HTTP (payment providers, SMS, webhooks): tests swap in a fake; JdkHttpTransport is the real one. */
public interface HttpTransport {
    record Request(String method, URI uri, Map<String, String> headers, byte[] body, Duration timeout) {
        public static Request get(URI uri) { return new Request("GET", uri, new LinkedHashMap<>(), new byte[0], Duration.ofSeconds(5)); }
        public static Request post(URI uri, byte[] json) {
            Map<String, String> h = new LinkedHashMap<>(); h.put("Content-Type", "application/json");
            return new Request("POST", uri, h, json, Duration.ofSeconds(5));
        }
        public Request header(String name, String value) { Map<String, String> h = new LinkedHashMap<>(headers); h.put(name, value); return new Request(method, uri, h, body, timeout); }
        public Request timeout(Duration t) { return new Request(method, uri, headers, body, t); }
    }
    record Response(int status, Map<String, String> headers, byte[] body) {
        public String text() { return new String(body, java.nio.charset.StandardCharsets.UTF_8); }
    }
    /** IOException / timeout surface as TransientFailure. */
    Response send(Request request);
}
