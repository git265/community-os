package com.communityos.api.property.web;

import com.communityos.api.property.application.UnitService;
import com.communityos.api.property.application.port.PropertySetup;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** The community's blocks, towers, phases and lanes: a name (unique whatever its case), an optional code and the block's own unit naming pattern. */
@RestController
@Tag(name = "Units")
public class BlockController {
    public record BlockRequest(@NotBlank @Size(max = 80) String name, @Size(max = 6) String code, @Size(max = 10) String kind, Integer sortOrder, @Size(max = 60) String unitPattern,
                               java.util.Map<String, Object> custom) {
        PropertySetup.BlockFields fields() { return new PropertySetup.BlockFields(name, code, kind, sortOrder, unitPattern, custom); }
    }
    private final UnitService units;
    public BlockController(UnitService units) { this.units = units; }

    @GetMapping("/api/v1/blocks") public List<PropertySetup.Block> list() { return units.blocks(CallerHolder.require()); }
    @PostMapping("/api/v1/blocks")
    public ResponseEntity<PropertySetup.Block> add(@Valid @RequestBody BlockRequest b) { return ResponseEntity.status(201).body(units.saveBlock(CallerHolder.require(), null, null, b.fields())); }
    @PutMapping("/api/v1/blocks/{id}")
    public PropertySetup.Block change(@PathVariable UUID id, @Valid @RequestBody BlockRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return units.saveBlock(CallerHolder.require(), id, ETags.require(ifMatch), b.fields());
    }
    @DeleteMapping("/api/v1/blocks/{id}")
    public ResponseEntity<Void> delete(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        units.deleteBlock(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }
}
