package com.communityos.api.shared.http;

import com.communityos.api.shared.resilience.TransientFailure;
import java.io.IOException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/** java.net.http client: HTTP/2 with connection reuse (one TLS handshake per provider, not per call), 3 s connect timeout, no redirects. */
public final class JdkHttpTransport implements HttpTransport {
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).version(HttpClient.Version.HTTP_2).build();

    @Override public Response send(Request r) {
        HttpRequest.Builder b = HttpRequest.newBuilder(r.uri()).timeout(r.timeout())
            .method(r.method(), r.body().length == 0 ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(r.body()));
        r.headers().forEach(b::header);
        try {
            HttpResponse<byte[]> res = client.send(b.build(), HttpResponse.BodyHandlers.ofByteArray());
            Map<String, String> h = new LinkedHashMap<>();
            res.headers().map().forEach((k, v) -> h.put(k.toLowerCase(), String.join(",", v)));
            return new Response(res.statusCode(), h, res.body());
        } catch (IOException e) { throw new TransientFailure(r.uri().getHost() + " unreachable: " + e.getMessage(), e); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new TransientFailure("interrupted", e); }
    }
}
