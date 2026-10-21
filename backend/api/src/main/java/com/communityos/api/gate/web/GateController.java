package com.communityos.api.gate.web;

import com.communityos.api.gate.application.GateService;
import com.communityos.api.gate.application.port.GateStore;
import com.communityos.api.gate.domain.Gate;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.communityos.api.shared.web.Idempotency;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;
import java.time.LocalTime;
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

/** The gate: passes (residents), the desk (guards), approvals (residents answer), flags and patrols. Each step its own request type. */
@RestController
@Tag(name = "Gate")
public class GateController {
    static final int PHOTO = 400_000;
    public record PassRequest(@NotBlank @Size(max = 120) String visitorName, @Size(max = 20) String phone, UUID unitId, @Pattern(regexp = "One-time|Recurring|Event|Goods") String type,
                              LocalDate validFrom, LocalDate validTo, LocalTime fromTime, LocalTime toTime, @Size(max = 7) List<String> days, @Size(max = 20) String vehicle,
                              Integer guestCap, @Size(max = 40) String goodsKind, Integer peopleCount, @Size(max = 200) String material, Boolean carryingOut, @Size(max = 500) String outItems,
                              @Size(max = PHOTO) String photo) {}
    public record AdmitPassRequest(@Size(max = 40) String gate, @Size(max = 20) String vehicle, @Size(max = PHOTO) String photo) {}
    public record GoodsRequest(@Size(max = 40) String gate, @NotNull @Min(1) @Max(200) Integer people, @Size(max = 20) String vehicle, @Size(max = PHOTO) String photo, @Size(max = 300) String force) {}
    public record AskRequest(@Size(max = 30) String kind, @NotBlank @Size(max = 120) String name, @Size(max = 20) String phone, @Size(max = 80) String company, @Size(max = 20) String vehicle,
                             @Size(max = 200) String purpose, UUID unitId, @Size(max = 40) String gate, @Size(max = PHOTO) String photo, UUID personId, UUID workOrderId,
                             @Min(1) @Max(200) Integer headcount, @Size(max = 200) String material) {}
    public record DeliveryRequest(@Size(max = 120) String name, @Size(max = 20) String phone, @Size(max = PHOTO) String photo, @Size(max = 60) String company, @NotNull UUID unitId,
                                  @Size(max = 40) String gate, @Size(max = 20) String vehicle) {}
    public record OverrideRequest(@Size(max = 120) String name, @NotBlank @Size(max = 300) String reason, @Size(max = PHOTO) String photo, UUID unitId, @Size(max = 40) String gate, @Size(max = 20) String vehicle) {}
    public record AdmitApprovedRequest(@Size(max = 300) String manualReason) {}
    public record NoteRequest(@Size(max = 300) String note) {}
    public record ExitRequest(@Size(max = 30) String method) {}
    public record ExitGoodsRequest(@NotNull @Min(0) @Max(200) Integer people, Boolean itemsChecked) {}
    public record PersonAtGateRequest(@Size(max = 40) String gate, @Size(max = 30) String method, UUID unitId) {}
    public record AnswerRequest(@NotNull @Pattern(regexp = "Approved|Denied") String decision, Boolean always) {}
    public record ResolveRequest(@NotBlank String resolution, @Size(max = 500) String note) {}
    public record ScanRequest(@NotBlank @Size(max = 200) String text, @Size(max = 300) String note) {}

    private final GateService gate; private final Idempotency idempotency;
    public GateController(GateService gate, Idempotency idempotency) { this.gate = gate; this.idempotency = idempotency; }

    // ---- passes ----------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/gate/passes")
    public List<Gate.Pass> passes(@RequestParam(required = false) String status) { return gate.passes(CallerHolder.require(), status); }
    @GetMapping("/api/v1/gate/passes/search")
    public List<GateService.PassCheck> search(@RequestParam String q) { return gate.findPasses(CallerHolder.require(), q); }
    @PostMapping("/api/v1/gate/passes")
    public ResponseEntity<Gate.Pass> createPass(@Valid @RequestBody PassRequest b, @RequestHeader(name = "Idempotency-Key", required = false) String key) {
        Caller c = CallerHolder.require();
        Idempotency.Reply<Gate.Pass> r = idempotency.run(c, key, "POST /api/v1/gate/passes", b, Gate.Pass.class, 201, () -> gate.createPass(c, new GateService.NewPass(b.visitorName(), b.phone(),
            b.unitId() == null ? null : new UnitId(b.unitId()), b.type(), b.validFrom(), b.validTo(), b.fromTime(), b.toTime(), b.days(), b.vehicle(), b.guestCap(), b.goodsKind(), b.peopleCount(),
            b.material(), Boolean.TRUE.equals(b.carryingOut()), b.outItems(), b.photo())));
        return ResponseEntity.status(r.status()).header("ETag", ETags.of(r.body().version)).body(r.body());
    }
    @PostMapping("/api/v1/gate/passes/{id}/cancel")
    public ResponseEntity<Gate.Pass> cancelPass(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Gate.Pass p = gate.cancelPass(CallerHolder.require(), id, ETags.require(ifMatch)); return ResponseEntity.ok().header("ETag", ETags.of(p.version)).body(p);
    }
    @PostMapping("/api/v1/gate/passes/{id}/admit")
    public GateService.Outcome admitPass(@PathVariable UUID id, @Valid @RequestBody AdmitPassRequest b) { return gate.admitPass(CallerHolder.require(), id, b.gate(), b.vehicle(), b.photo()); }
    @PostMapping("/api/v1/gate/passes/{id}/admit-goods")
    public GateService.Outcome admitGoods(@PathVariable UUID id, @Valid @RequestBody GoodsRequest b) {
        return gate.admitGoods(CallerHolder.require(), id, b.gate(), b.people(), b.vehicle(), b.photo(), b.force());
    }

    // ---- the desk -------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/gate/visits")
    public List<Gate.Visit> visits(@RequestParam(required = false) String state, @RequestParam(required = false) UUID unit, @RequestParam(required = false) LocalDate from,
                                   @RequestParam(required = false) LocalDate to, @RequestParam(defaultValue = "false") boolean open) {
        return gate.visits(CallerHolder.require(), new GateStore.VisitFilter(state, unit, from, to, open));
    }
    @PostMapping("/api/v1/gate/visits/ask")
    public GateService.Outcome ask(@Valid @RequestBody AskRequest b) {
        return gate.ask(CallerHolder.require(), new GateService.Ask(b.kind(), b.name(), b.phone(), b.company(), b.vehicle(), b.purpose(), b.unitId() == null ? null : new UnitId(b.unitId()),
            b.gate(), b.photo(), b.personId(), b.workOrderId(), b.headcount(), b.material()));
    }
    @PostMapping("/api/v1/gate/visits/delivery")
    public GateService.Outcome delivery(@Valid @RequestBody DeliveryRequest b) {
        return gate.delivery(CallerHolder.require(), b.name(), b.phone(), b.photo(), b.company(), new UnitId(b.unitId()), b.gate(), b.vehicle());
    }
    @PostMapping("/api/v1/gate/visits/override")
    public Gate.Visit override(@Valid @RequestBody OverrideRequest b) {
        return gate.override(CallerHolder.require(), b.name(), b.reason(), b.photo(), b.unitId() == null ? null : new UnitId(b.unitId()), b.gate(), b.vehicle());
    }
    @PostMapping("/api/v1/gate/visits/{id}/admit")
    public Gate.Visit admitApproved(@PathVariable UUID id, @Valid @RequestBody AdmitApprovedRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return gate.admitApproved(CallerHolder.require(), id, ETags.require(ifMatch), b.manualReason());
    }
    @PostMapping("/api/v1/gate/visits/{id}/ask-again")
    public GateService.Outcome askAgain(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) { return gate.askAgain(CallerHolder.require(), id, ETags.require(ifMatch)); }
    @PostMapping("/api/v1/gate/visits/{id}/refuse")
    public Gate.Visit refuse(@PathVariable UUID id, @Valid @RequestBody NoteRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return gate.refuse(CallerHolder.require(), id, ETags.require(ifMatch), b.note());
    }
    @PostMapping("/api/v1/gate/visits/{id}/exit")
    public Gate.Visit exit(@PathVariable UUID id, @Valid @RequestBody ExitRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return gate.exit(CallerHolder.require(), id, ETags.require(ifMatch), b.method());
    }
    @PostMapping("/api/v1/gate/visits/{id}/exit-goods")
    public Gate.Visit exitGoods(@PathVariable UUID id, @Valid @RequestBody ExitGoodsRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return gate.exitGoods(CallerHolder.require(), id, ETags.require(ifMatch), b.people(), Boolean.TRUE.equals(b.itemsChecked()));
    }
    @PostMapping("/api/v1/gate/people/{id}/admit")
    public GateService.Outcome admitPerson(@PathVariable UUID id, @Valid @RequestBody PersonAtGateRequest b) {
        return gate.admitPerson(CallerHolder.require(), id, b.gate(), b.method(), b.unitId() == null ? null : new UnitId(b.unitId()));
    }
    @PostMapping("/api/v1/gate/people/{id}/exit")
    public Gate.Visit exitPerson(@PathVariable UUID id, @Valid @RequestBody ExitRequest b) { return gate.exitPerson(CallerHolder.require(), id, b.method()); }

    // ---- approvals, flags, patrols ----------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/gate/approvals")
    public List<Gate.Approval> approvals(@RequestParam(required = false) String status) { return gate.approvals(CallerHolder.require(), status); }
    @PostMapping("/api/v1/gate/approvals/{id}/answer")
    public Gate.Approval answer(@PathVariable UUID id, @Valid @RequestBody AnswerRequest b) { return gate.answer(CallerHolder.require(), id, b.decision(), Boolean.TRUE.equals(b.always())); }
    @GetMapping("/api/v1/gate/flags")
    public List<Gate.Flag> flags(@RequestParam(defaultValue = "false") boolean open) { return gate.flags(CallerHolder.require(), open); }
    @PostMapping("/api/v1/gate/flags/{id}/resolve")
    public Gate.Flag resolve(@PathVariable UUID id, @Valid @RequestBody ResolveRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return gate.resolveFlag(CallerHolder.require(), id, ETags.require(ifMatch), b.resolution(), b.note());
    }
    @GetMapping("/api/v1/gate/scans")
    public List<GateStore.Scan> scans(@RequestParam(required = false) LocalDate since) { return gate.scans(CallerHolder.require(), since); }
    @PostMapping("/api/v1/gate/scans")
    public GateService.ScanResult scan(@Valid @RequestBody ScanRequest b) { return gate.scan(CallerHolder.require(), b.text(), b.note()); }
    @PostMapping("/api/v1/gate/beat")
    public ResponseEntity<Void> beat() { gate.beat(CallerHolder.require()); return ResponseEntity.noContent().build(); }
}
