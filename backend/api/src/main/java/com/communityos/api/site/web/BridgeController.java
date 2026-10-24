package com.communityos.api.site.web;

import com.communityos.api.site.application.SiteService;
import com.communityos.api.site.domain.Site;
import com.fasterxml.jackson.databind.JsonNode;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The site bridge's side: it connects out from the community's network, signs every call with its token (X-Bridge-Token, not a user's sign-in)
 * and acts for its own community only. Hello (its devices), jobs and their results, punches, health.
 */
@RestController
@Tag(name = "Site bridge")
public class BridgeController {
    static final String TOKEN = "X-Bridge-Token", AGENT = "X-Bridge-Agent";
    public record TaskResultRequest(boolean ok, @Size(max = 1000) String error, boolean permanent) {}
    public record PunchRequest(@NotNull Long eventNo, Instant at, @Size(max = 20) String credential, @Size(max = 64) String employeeNo, @Size(max = 64) String cardNo,
                               @Size(max = 20) String result, @Size(max = 500) String reason, @Size(max = 40) String attendanceStatus, @Size(max = 400_000) String photo, JsonNode raw) {
        Site.Punch punch() { return new Site.Punch(eventNo, at, credential, employeeNo, cardNo, result, reason, attendanceStatus, photo, raw == null || raw.isNull() ? null : raw.toString()); }
    }
    public record EventsRequest(@NotNull UUID deviceId, @NotNull @Size(max = 500) List<@Valid PunchRequest> events) {}
    public record HealthRequest(@Size(max = 200) List<Site.Health> devices) {}

    private final SiteService site;
    public BridgeController(SiteService site) { this.site = site; }

    @GetMapping("/api/v1/bridge/hello")
    public SiteService.Hello hello(@RequestHeader(value = TOKEN, required = false) String token, @RequestHeader(value = AGENT, required = false) String agent) {
        return site.asBridge(token, agent, site::hello);
    }
    @GetMapping("/api/v1/bridge/tasks")
    public List<Site.Task> tasks(@RequestHeader(value = TOKEN, required = false) String token, @RequestHeader(value = AGENT, required = false) String agent,
                                 @RequestParam(required = false) Integer max) {
        return site.asBridge(token, agent, (c, b) -> site.tasks(c, b, max));
    }
    @PostMapping("/api/v1/bridge/tasks/{id}")
    public ResponseEntity<Void> taskResult(@RequestHeader(value = TOKEN, required = false) String token, @RequestHeader(value = AGENT, required = false) String agent,
                                           @PathVariable UUID id, @Valid @RequestBody TaskResultRequest r) {
        site.asBridge(token, agent, (c, b) -> { site.taskResult(c, b, id, r.ok(), r.error(), r.permanent()); return null; });
        return ResponseEntity.noContent().build();
    }
    @PostMapping("/api/v1/bridge/events")
    public SiteService.Ingest events(@RequestHeader(value = TOKEN, required = false) String token, @RequestHeader(value = AGENT, required = false) String agent,
                                     @Valid @RequestBody EventsRequest r) {
        return site.asBridge(token, agent, (c, b) -> site.events(c, b, r.deviceId(), r.events().stream().map(PunchRequest::punch).toList()));
    }
    @PostMapping("/api/v1/bridge/health")
    public ResponseEntity<Void> health(@RequestHeader(value = TOKEN, required = false) String token, @RequestHeader(value = AGENT, required = false) String agent,
                                       @Valid @RequestBody HealthRequest r) {
        site.asBridge(token, agent, (c, b) -> { site.health(c, b, r.devices()); return null; });
        return ResponseEntity.noContent().build();
    }
}
