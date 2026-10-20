package com.communityos.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import com.communityos.config.AppProperties;
import com.communityos.port.DocumentRepository;
import com.communityos.port.FileStorage;
import com.communityos.port.GstProvider;
import com.communityos.port.OutboundChannel;
import com.communityos.port.PaymentProvider;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** GET /api/health - open to everyone. The UI's "Test connection" shows these lines, so you can see which vendors are wired. */
@Tag(name = "Health")
@RestController
public class HealthController {
    private final DocumentRepository repo;
    private final FileStorage files;
    private final List<OutboundChannel> channels;
    private final PaymentProvider payments;
    private final GstProvider gst;
    private final AppProperties props;

    public HealthController(DocumentRepository repo, FileStorage files, List<OutboundChannel> channels, PaymentProvider payments, GstProvider gst, AppProperties props) {
        this.repo = repo; this.files = files; this.channels = channels; this.payments = payments; this.gst = gst; this.props = props;
    }

    @Operation(summary = "Is the service up?", description = "Open to everyone. 503 when the database is down.")
    @GetMapping("/api/health")
    public ResponseEntity<Map<String, Object>> health() {
        String db; boolean up = true;
        try { db = repo.ping(); } catch (Exception e) { db = "down"; up = false; }
        Map<String, Object> providers = new LinkedHashMap<>();
        providers.put("storage", props.storage().provider() + (props.storage().typedTables() ? "+typed-tables" : ""));
        providers.put("files", files.name());
        channels.forEach(c -> providers.put(c.channel().toLowerCase(), c.provider()));
        providers.put("payments", payments.id());
        providers.put("gst", gst.id());
        providers.put("security", props.security().mode());
        providers.put("settlement", "server-side (repeatable read, outbox event payment.settled)");
        providers.put("idempotency", props.idempotency().enabled() ? "Idempotency-Key, " + props.idempotency().hours() + " h" : "off");
        providers.put("authorization", "rule-book");   // the Java rule book, proven equal to the web app's by RuleBookConformanceTest
        providers.put("unportedHooks", props.security().unportedHooks() + (com.communityos.access.ServerHooks.guardedCollections().isEmpty() ? " (nothing is guarded)" : " (" + String.join(", ", com.communityos.access.ServerHooks.guardedCollections()) + ")"));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", up ? "UP" : "DOWN");
        body.put("database", db);
        body.put("version", "communityos-backend 1.0.0");
        body.put("providers", providers);
        return ResponseEntity.status(up ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).body(body);
    }
}
