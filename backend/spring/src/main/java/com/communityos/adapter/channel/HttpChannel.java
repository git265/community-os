package com.communityos.adapter.channel;

import com.communityos.config.AppProperties;
import com.communityos.domain.OutboundMessage;
import com.communityos.port.OutboundChannel;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Any SMS or WhatsApp provider that takes an HTTP request: Twilio, MSG91, Gupshup, Meta WhatsApp Cloud API, Kaleyra ...
 * You give it the URL, an Authorization header and a body template with {to}, {text}, {subject}, {name}. Values are
 * JSON-escaped, so put them inside quotes in a JSON template. No code change to move between vendors, unless a vendor
 * needs a signed request or form encoding - then add a class like this one.
 */
public class HttpChannel implements OutboundChannel {
    private final String channel;
    private final AppProperties.Channels.HttpTarget target;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final ObjectMapper json = new ObjectMapper();

    public HttpChannel(String channel, AppProperties.Channels.HttpTarget target) {
        if (target.url() == null || target.url().isBlank()) throw new IllegalStateException("The " + channel + " URL is not set (see application.yml).");
        this.channel = channel;
        this.target = target;
    }

    @Override public String channel() { return channel; }
    @Override public String provider() { return "http"; }

    private String esc(String s) {
        try { String q = json.writeValueAsString(s == null ? "" : s); return q.substring(1, q.length() - 1); }
        catch (JsonProcessingException e) { throw new IllegalStateException(e); }
    }

    @Override public void send(OutboundMessage m) throws Exception {
        String body = target.bodyTemplate().replace("{to}", esc(m.to())).replace("{text}", esc(m.body()))
                .replace("{subject}", esc(m.subject())).replace("{name}", esc(m.toName()));
        HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(target.url())).timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/json")
                .method(target.method(), HttpRequest.BodyPublishers.ofString(body));
        if (target.authHeader() != null && !target.authHeader().isBlank()) rb.header("Authorization", target.authHeader());
        HttpResponse<String> r = client.send(rb.build(), HttpResponse.BodyHandlers.ofString());
        if (r.statusCode() / 100 != 2) throw new IllegalStateException(channel + " provider answered " + r.statusCode());
    }
}
