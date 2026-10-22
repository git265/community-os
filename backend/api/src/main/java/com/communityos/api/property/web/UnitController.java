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
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.property.application.UnitService;
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
    public record UnitPatch(@Size(max = 60) String unitNo, @Size(max = 40) String unitType, @Size(max = 20) String occupancy, BigDecimal areaSqft, @Size(max = 20) String maintenancePlan,
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
        Unit u = units.change(CallerHolder.require(), new UnitId(id), ETags.require(ifMatch), b.unitNo(),
            new Unit.Changes(b.unitType(), b.occupancy(), b.areaSqft(), b.maintenancePlan(), b.sanctionedKw()), b.custom());
        return ResponseEntity.ok().header("ETag", ETags.of(u.version())).body(UnitResponse.of(u));
    }

    // ---- adding units, the naming pattern --------------------------------------------------------------------------------------------------------
    public record NewUnitRequest(@jakarta.validation.constraints.NotBlank @Size(max = 60) String unitNo, UUID blockId, @Size(max = 40) String unitType,
                                 @Size(max = 20) String occupancy, BigDecimal areaSqft) {
        com.communityos.api.property.application.port.PropertySetup.NewUnit row() { return new com.communityos.api.property.application.port.PropertySetup.NewUnit(unitNo, blockId, unitType, occupancy, areaSqft); }
    }
    public record BatchRequest(@jakarta.validation.constraints.NotNull @Size(min = 1, max = UnitService.BATCH_MAX) java.util.List<@Valid NewUnitRequest> units) {}
    public record NamingRequest(@Size(max = 120) String unitPattern) {}

    /** One new unit: its number follows the community's rules (or 422 with what is wrong); a number already in use (any case) is 422 duplicate-unit. */
    @PostMapping
    public ResponseEntity<UnitResponse> add(@Valid @RequestBody NewUnitRequest b) {
        Caller c = CallerHolder.require();
        UnitService.Batch r = units.add(c, java.util.List.of(b.row()));
        if (r.added().isEmpty()) throw new com.communityos.api.shared.domain.DomainException.RuleViolated("duplicate-unit", "There is already a unit “" + r.skipped().get(0) + "” (numbers are the same whatever their case)");
        Unit u = units.get(c, new UnitId(r.added().get(0).id()));
        return ResponseEntity.status(201).header("ETag", ETags.of(u.version())).body(UnitResponse.of(u));
    }
    /** Many at once (bulk add, import): all are checked first; numbers already there are skipped and listed. */
    @PostMapping("/batch")
    public ResponseEntity<UnitService.Batch> addMany(@Valid @RequestBody BatchRequest b) {
        return ResponseEntity.status(201).body(units.add(CallerHolder.require(), b.units().stream().map(NewUnitRequest::row).toList()));
    }
    @GetMapping("/naming")
    public com.communityos.api.property.application.port.PropertySetup.Setting naming() { return units.naming(CallerHolder.require()); }
    @PutMapping("/naming")
    public com.communityos.api.property.application.port.PropertySetup.Setting setNaming(@Valid @RequestBody NamingRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return units.setNaming(CallerHolder.require(), b.unitPattern(), ifMatch == null ? 0 : ETags.require(ifMatch));
    }
}
