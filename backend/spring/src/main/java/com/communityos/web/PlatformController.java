package com.communityos.web;

import com.communityos.platform.PlatformService;
import com.fasterxml.jackson.databind.JsonNode;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** /api/platform: the platform console (no community sign-in; the X-Platform-Key header is the credential). Same answers as the Node server's. */
@RestController
@Tag(name = "Platform")
public class PlatformController {
    private final PlatformService platform;
    public PlatformController(PlatformService platform) { this.platform = platform; }

    private ResponseEntity<Object> answer(String key, Supplier<Object> work) {
        try { platform.check(key); return ResponseEntity.ok(work.get()); }
        catch (PlatformService.Refused r) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("message", r.getMessage()); body.put("code", r.code);
            if (r.errors != null) body.put("errors", r.errors);
            return ResponseEntity.status(r.status).body(body);
        }
    }

    @Operation(summary = "The communities", description = "Each with the number of people who can sign in. X-Platform-Key required.")
    @GetMapping("/api/platform/communities")
    public ResponseEntity<Object> list(@RequestHeader(value = "X-Platform-Key", required = false) String key) { return answer(key, platform::list); }

    @Operation(summary = "Create a community", description = "Registry row, default roles, task types, templates and the first Super Admin, in one transaction. X-Platform-Key required.")
    @PostMapping("/api/platform/communities")
    public ResponseEntity<Object> create(@RequestHeader(value = "X-Platform-Key", required = false) String key, @RequestBody JsonNode body) { return answer(key, () -> platform.create(body)); }

    @Operation(summary = "Suspend or re-activate a community", description = "{ status: Active | Suspended }. X-Platform-Key required.")
    @PatchMapping("/api/platform/communities/{slug}")
    public ResponseEntity<Object> status(@RequestHeader(value = "X-Platform-Key", required = false) String key, @PathVariable String slug, @RequestBody JsonNode body) {
        return answer(key, () -> platform.setStatus(slug, body.path("status").asText("")));
    }
}
