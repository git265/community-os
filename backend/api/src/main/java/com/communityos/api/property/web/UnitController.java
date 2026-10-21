package com.communityos.api.property.web;

import com.communityos.api.property.application.UnitService;
import com.communityos.api.property.application.port.UnitRepository;
import com.communityos.api.property.domain.Unit;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.communityos.api.shared.web.PageQuery;
import com.communityos.api.shared.web.PageResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/units")
@Tag(name = "Units")
public class UnitController {
    /** The only fields a unit manager may change; the number, block, status and audit columns are not in it, so they cannot be sent. */
    public record UnitPatch(@Size(max = 40) String unitType, @Size(max = 20) String occupancy, BigDecimal areaSqft, @Size(max = 20) String maintenancePlan,
                            BigDecimal sanctionedKw, @Size(max = 50) Map<String, Object> custom) {}
    public record UnitResponse(UUID id, String shortId, String unitNo, UUID blockId, String blockName, String unitType, String occupancy, BigDecimal areaSqft,
                               String maintenancePlan, BigDecimal sanctionedKw, String status, Map<String, Object> custom, Instant updatedAt, long version) {
        static UnitResponse of(Unit u) {
            return new UnitResponse(u.id().value(), u.shortId(), u.unitNo(), u.block() == null ? null : u.block().value(), u.blockName(), u.unitType(), u.occupancy(),
                u.areaSqft(), u.maintenancePlan(), u.sanctionedKw(), u.status(), u.custom(), u.updatedAt(), u.version());
        }
    }

    private final UnitService units;
    public UnitController(UnitService units) { this.units = units; }

    @GetMapping
    public PageResponse<UnitResponse> list(@RequestParam(required = false) String q, @RequestParam(required = false) UUID block, @RequestParam(required = false) String occupancy,
                                           @RequestParam(defaultValue = "false") boolean archived, @RequestParam(required = false) Integer limit, @RequestParam(required = false) Integer offset) {
        return PageResponse.of(units.list(CallerHolder.require(), new UnitRepository.Filter(q, block == null ? null : new BlockId(block), occupancy, archived),
            PageQuery.of(limit, offset)).map(UnitResponse::of));
    }
    @GetMapping("/{id}")
    public ResponseEntity<UnitResponse> get(@PathVariable UUID id) {
        Unit u = units.get(CallerHolder.require(), new UnitId(id));
        return ResponseEntity.ok().header("ETag", ETags.of(u.version())).body(UnitResponse.of(u));
    }
    @PatchMapping("/{id}")
    public ResponseEntity<UnitResponse> patch(@PathVariable UUID id, @Valid @RequestBody UnitPatch b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Unit u = units.change(CallerHolder.require(), new UnitId(id), ETags.require(ifMatch),
            new Unit.Changes(b.unitType(), b.occupancy(), b.areaSqft(), b.maintenancePlan(), b.sanctionedKw()), b.custom());
        return ResponseEntity.ok().header("ETag", ETags.of(u.version())).body(UnitResponse.of(u));
    }
}
