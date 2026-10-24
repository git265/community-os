package com.communityos.api.assets.web;

import com.communityos.api.assets.application.AssetService;
import com.communityos.api.assets.application.port.AssetStore;
import com.communityos.api.shared.tenancy.CallerHolder;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Stock movements and an asset's condition. The registers themselves are the resource kit (/api/v1/assets/...). */
@RestController
@Tag(name = "Assets")
public class AssetController {
    public record MoveRequest(@NotNull @Pattern(regexp = "Received|Issued|Counted") String kind, @NotNull BigDecimal quantity, LocalDate date, UUID ticketId, @Size(max = 200) String vendor,
                              @Size(max = 1000) String note) {}
    public record ConditionRequest(@NotNull UUID assetId, LocalDate date, @NotNull @Size(max = 40) String condition, @Size(max = 80) String source, @Size(max = 4000) String note, UUID ticketId) {}

    private final AssetService assets;
    public AssetController(AssetService assets) { this.assets = assets; }

    @PostMapping("/api/v1/assets/inventory/{id}/movements")
    public ResponseEntity<AssetService.Moved> move(@PathVariable UUID id, @Valid @RequestBody MoveRequest b) {
        return ResponseEntity.status(201).body(assets.move(CallerHolder.require(), id, b.kind(), b.quantity(), b.date(), b.ticketId(), b.vendor(), b.note()));
    }
    @GetMapping("/api/v1/assets/inventory/{id}/movements")
    public List<AssetStore.Movement> movements(@PathVariable UUID id) { return assets.movements(CallerHolder.require(), id); }
    public record VisitRequest(LocalDate date, @Size(max = 30) String kind, @Size(max = 60) String vendor, @Size(max = 40) String condition, @Size(max = 4000) String note, LocalDate nextService) {}
    /** An AMC / service visit on an asset: its condition history and service dates (the report is attached to the entry it returns). */
    @PostMapping("/api/v1/assets/{id}/service-visits")
    public ResponseEntity<AssetStore.ConditionEntry> serviceVisit(@PathVariable UUID id, @Valid @RequestBody VisitRequest b) {
        return ResponseEntity.status(201).body(assets.serviceVisit(CallerHolder.require(), id, b.date(), b.kind(), b.vendor(), b.condition(), b.note(), b.nextService()));
    }
    @PostMapping("/api/v1/assets/condition-log")
    public ResponseEntity<AssetStore.ConditionEntry> condition(@Valid @RequestBody ConditionRequest b) {
        return ResponseEntity.status(201).body(assets.condition(CallerHolder.require(), b.assetId(), b.date(), b.condition(), b.source(), b.note(), b.ticketId()));
    }
}
