package com.communityos.api.comms.web;

import com.communityos.api.comms.adapter.LiveHub;
import com.communityos.api.comms.application.PushService;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Notifications pushed by the server:
 *   GET    /api/v1/notifications/stream        the open app: a Server-Sent Events stream ("notification" events as they happen, "ping" now and
 *                                              then). It ends after STREAM_MINUTES; the app opens a new one with a fresh token (a signed-out
 *                                              person's stream ends with it)
 *   GET    /api/v1/push/key                    the VAPID public key the browser subscribes with (Web Push, when the app is closed)
 *   POST   /api/v1/push/subscriptions          this browser / device's subscription, after the person allowed notifications
 *   DELETE /api/v1/push/subscriptions?endpoint the same, at sign-out or when the person turns them off
 */
@RestController
@Tag(name = "Push")
public class PushController {
    static final long STREAM_MINUTES = 5;
    public record Keys(@NotBlank @Size(max = 100) String p256dh, @NotBlank @Size(max = 40) String auth) {}
    public record SubscriptionRequest(@NotBlank @Size(max = 1000) String endpoint, @NotNull @Valid Keys keys) {}

    private final LiveHub hub; private final PushService push;
    public PushController(LiveHub hub, PushService push) { this.hub = hub; this.push = push; }

    @GetMapping(value = "/api/v1/notifications/stream", produces = "text/event-stream")
    public ResponseEntity<SseEmitter> stream() {
        Caller c = CallerHolder.require();
        if (c.membership() == null) throw new DomainException.RuleViolated("no-member", "Only a member has notifications");
        UUID member = c.membership().value(), community = c.community().value();
        SseEmitter em = new SseEmitter(STREAM_MINUTES * 60_000);
        LiveHub.Tab tab = (event, data) -> {
            try { em.send(SseEmitter.event().name(event).data(data)); return true; }
            catch (IOException | IllegalStateException e) { return false; }
        };
        em.onCompletion(() -> hub.disconnect(member, tab));
        em.onTimeout(() -> { hub.disconnect(member, tab); em.complete(); });
        em.onError((e) -> hub.disconnect(member, tab));
        hub.connect(community, member, tab);
        tab.send("ready", Map.of("reconnectAfterMinutes", STREAM_MINUTES));
        // no buffering on the way (nginx), no caching: each event leaves at once
        return ResponseEntity.ok().header("Cache-Control", "no-store").header("X-Accel-Buffering", "no").body(em);
    }

    @GetMapping("/api/v1/push/key")
    public Map<String, Object> key() {
        CallerHolder.require();
        PushService.Key k = push.key();
        return k.publicKey() == null ? Map.of("provider", k.provider()) : Map.of("publicKey", k.publicKey(), "provider", k.provider());
    }
    @PostMapping("/api/v1/push/subscriptions")
    public ResponseEntity<Map<String, Object>> subscribe(@Valid @RequestBody SubscriptionRequest b, HttpServletRequest req) {
        Caller c = CallerHolder.require();
        push.subscribe(c, b.endpoint(), b.keys().p256dh(), b.keys().auth(), req.getHeader("User-Agent"));
        return ResponseEntity.status(201).body(Map.of("devices", push.devices(c)));
    }
    @DeleteMapping("/api/v1/push/subscriptions")
    public ResponseEntity<Void> unsubscribe(@RequestParam String endpoint) {
        push.unsubscribe(CallerHolder.require(), endpoint);
        return ResponseEntity.noContent().build();
    }
}
