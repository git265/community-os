package com.communityos.service;

import com.communityos.config.AppProperties;
import com.communityos.domain.OutboundMessage;
import com.communityos.port.DocumentRepository;
import com.communityos.port.OutboundChannel;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * Sends the messages the UI queues in the `notificationOutbox` collection (status "Queued ..."). Runs only when
 * app.channels.enabled=true, so exactly one instance sends. Each row is marked Sent or Failed; failures are retried next run.
 * The channel adapters (log / SMTP / HTTP) are chosen in ProvidersConfig - this class never knows the vendor.
 */
@Service
public class OutboxDispatcher {
    private static final Logger log = LoggerFactory.getLogger(OutboxDispatcher.class);
    private final DocumentRepository repo;
    private final Map<String, OutboundChannel> channels;
    private final AppProperties.Channels cfg;

    public OutboxDispatcher(DocumentRepository repo, List<OutboundChannel> channels, AppProperties props) {
        this.repo = repo;
        this.channels = channels.stream().collect(Collectors.toMap(OutboundChannel::channel, Function.identity()));
        this.cfg = props.channels();
    }

    @Scheduled(fixedDelayString = "${app.channels.poll-ms:30000}", initialDelayString = "${app.channels.poll-ms:30000}")
    public void tick() {
        if (cfg.enabled()) runOnce();
    }

    /** @return how many messages were sent */
    public int runOnce() {
        int sent = 0;
        for (String tenant : repo.tenants()) {
            if ("platform".equals(tenant)) continue;
            for (JsonNode row : repo.list(tenant, cfg.outboxCollection())) {
                String status = row.path("status").asText("");
                if (!status.startsWith("Queued") && !status.startsWith("Failed")) continue;
                OutboundChannel ch = channels.get(row.path("channel").asText());
                if (ch == null) continue;
                ObjectNode patch = ((ObjectNode) row).objectNode();
                patch.put("id", row.path("id").asText());
                try {
                    ch.send(new OutboundMessage(row.path("id").asText(), ch.channel(), row.path("to").asText(), (row.hasNonNull("toName") ? row.path("toName") : row.path("toLabel")).asText(),
                            row.path("subject").asText(), row.path("body").asText()));
                    patch.put("status", "Sent");
                    patch.put("sentAt", Instant.now().toString());
                    sent++;
                } catch (Exception e) {
                    log.warn("Could not send {} to {}: {}", ch.channel(), row.path("to").asText(), e.getMessage());
                    patch.put("status", "Failed - will retry");
                }
                repo.upsert(tenant, cfg.outboxCollection(), row.path("id").asText(), patch);
            }
        }
        return sent;
    }
}
