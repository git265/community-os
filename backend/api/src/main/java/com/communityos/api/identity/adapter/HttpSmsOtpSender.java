package com.communityos.api.identity.adapter;

import com.communityos.api.identity.application.port.OtpSender;
import com.communityos.api.identity.domain.Phone;
import com.communityos.api.shared.http.HttpTransport;
import com.communityos.api.shared.resilience.Resilient;
import com.communityos.api.shared.resilience.TransientFailure;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.util.Map;

/**
 * Sends the code through an SMS / WhatsApp provider's JSON API (DLT template id for India). Wrapped in Resilient: 3 s timeout, 2 attempts,
 * circuit breaker - a provider outage fails fast instead of holding sign-in requests.
 */
public final class HttpSmsOtpSender implements OtpSender {
    public record Settings(URI endpoint, String apiKey, String templateId, String senderId) {}
    private final HttpTransport http; private final Resilient resilient; private final Settings s; private final ObjectMapper json;

    public HttpSmsOtpSender(HttpTransport http, Resilient resilient, Settings settings, ObjectMapper json) { this.http = http; this.resilient = resilient; this.s = settings; this.json = json; }

    @Override public void send(Phone to, String code) {
        byte[] body;
        try { body = json.writeValueAsBytes(Map.of("template_id", s.templateId(), "sender", s.senderId(), "to", to.e164().substring(1), "variables", Map.of("otp", code))); }
        catch (Exception e) { throw new IllegalStateException(e); }
        resilient.call(() -> {
            HttpTransport.Response r = http.send(HttpTransport.Request.post(s.endpoint(), body).header("Authorization", "Bearer " + s.apiKey()));
            if (r.status() >= 500 || r.status() == 429) throw new TransientFailure("SMS provider answered " + r.status());
            if (r.status() >= 400) throw new IllegalStateException("SMS provider refused the message: " + r.status());
            return null;
        });
    }
}
