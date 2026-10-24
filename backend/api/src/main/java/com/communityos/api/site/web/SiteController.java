package com.communityos.api.site.web;

import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.site.application.SiteService;
import com.communityos.api.site.domain.Site;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The site's devices for the security team and the administrators: bridges, devices, who is on them, the punches, face consent. */
@RestController
@Tag(name = "Site devices")
public class SiteController {
    public record DeviceRequest(@Size(max = 80) String name, @Size(max = 60) String gate, String kind, @Size(max = 60) String make, @Size(max = 60) String model, String driver,
                                String direction, @Size(max = 8) List<String> capabilities, UUID bridgeId, @Size(max = 100) String host, Integer port, Boolean useTls,
                                @Size(max = 64) String username, @Size(max = 64) String password, Integer doorNo, Integer capacity, String status) {
        Site.DeviceFields fields() { return new Site.DeviceFields(name, gate, kind, make, model, driver, direction, capabilities, bridgeId, host, port, useTls, username, password, doorNo, capacity, status); }
    }
    public record BridgeRequest(@NotBlank @Size(max = 80) String name) {}
    public record OpenRequest(@NotBlank @Size(max = 200) String reason) {}
    public record ConsentRequest(boolean consent, @Size(max = 420_000) String photo, @Size(max = 20) String cardNo, @Size(max = 2000) String text) {}

    private final SiteService site;
    public SiteController(SiteService site) { this.site = site; }

    @GetMapping("/api/v1/site/devices")
    public List<Site.Device> devices() { return site.devices(CallerHolder.require()); }
    @PostMapping("/api/v1/site/devices")
    public ResponseEntity<Site.Device> addDevice(@Valid @RequestBody DeviceRequest b) { return ResponseEntity.status(201).body(site.saveDevice(CallerHolder.require(), null, b.fields())); }
    @PutMapping("/api/v1/site/devices/{id}")
    public Site.Device changeDevice(@PathVariable UUID id, @Valid @RequestBody DeviceRequest b) { return site.saveDevice(CallerHolder.require(), id, b.fields()); }
    @PostMapping("/api/v1/site/devices/{id}/open")
    public ResponseEntity<Void> open(@PathVariable UUID id, @Valid @RequestBody OpenRequest b) { site.openDoor(CallerHolder.require(), id, b.reason()); return ResponseEntity.status(202).build(); }
    @PostMapping("/api/v1/site/devices/{id}/resync")
    public SiteService.SyncResult resync(@PathVariable UUID id) { return site.resync(CallerHolder.require(), id); }
    @GetMapping("/api/v1/site/devices/{id}/enrolments")
    public List<Site.Enrolment> enrolments(@PathVariable UUID id) { return site.enrolments(CallerHolder.require(), id); }

    @GetMapping("/api/v1/site/bridges")
    public List<Site.Bridge> bridges() { return site.bridges(CallerHolder.require()); }
    /** The token comes back this once. */
    @PostMapping("/api/v1/site/bridges")
    public ResponseEntity<SiteService.NewBridge> addBridge(@Valid @RequestBody BridgeRequest b) { return ResponseEntity.status(201).body(site.createBridge(CallerHolder.require(), b.name())); }
    @PostMapping("/api/v1/site/bridges/{id}/revoke")
    public ResponseEntity<Void> revoke(@PathVariable UUID id) { site.revokeBridge(CallerHolder.require(), id); return ResponseEntity.noContent().build(); }

    @GetMapping("/api/v1/site/events")
    public List<Site.Event> events(@RequestParam(required = false) Instant since, @RequestParam(required = false) Integer limit) { return site.events(CallerHolder.require(), since, limit); }
    @GetMapping("/api/v1/site/events/{id}/photo")
    public ResponseEntity<Map<String, String>> photo(@PathVariable UUID id) {
        return site.eventPhoto(CallerHolder.require(), id).map((p) -> ResponseEntity.ok(Map.of("photo", p))).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/api/v1/site/faces")
    public List<Site.FaceProfile> faces() { return site.profiles(CallerHolder.require()); }
    @GetMapping("/api/v1/site/faces/{kind}/{id}")
    public ResponseEntity<Site.FaceProfile> face(@PathVariable String kind, @PathVariable UUID id) {
        return site.profile(CallerHolder.require(), kind, id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }
    @PutMapping("/api/v1/site/faces/{kind}/{id}")
    public ResponseEntity<Site.FaceProfile> saveFace(@PathVariable String kind, @PathVariable UUID id, @Valid @RequestBody ConsentRequest b) {
        return site.saveProfile(CallerHolder.require(), kind, id, new SiteService.Consent(b.consent(), b.photo(), b.cardNo(), b.text())).map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.noContent().build());
    }
    @PostMapping("/api/v1/site/sync")
    public SiteService.SyncResult sync() { return site.sync(CallerHolder.require()); }
}
