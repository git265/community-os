package com.communityos.api.billing.web;

import com.communityos.api.billing.application.DueService;
import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.billing.web.BillingDtos.DueResponse;
import com.communityos.api.billing.web.BillingDtos.RaiseDueRequest;
import com.communityos.api.billing.web.BillingDtos.ReasonRequest;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.communityos.api.shared.web.Idempotency;
import com.communityos.api.shared.web.PageQuery;
import com.communityos.api.shared.web.PageResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/dues")
@Tag(name = "Bills")
public class DueController {
    private final DueService dues; private final Idempotency idempotency;
    public DueController(DueService dues, Idempotency idempotency) { this.dues = dues; this.idempotency = idempotency; }

    @GetMapping
    public PageResponse<DueResponse> list(@RequestParam(required = false) UUID unit, @RequestParam(required = false) String status, @RequestParam(defaultValue = "false") boolean open,
                                          @RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to, @RequestParam(required = false) String category,
                                          @RequestParam(required = false) Integer limit, @RequestParam(required = false) Integer offset) {
        DueRepository.Filter f = new DueRepository.Filter(unit == null ? null : new UnitId(unit), status, from, to, category, open);
        return PageResponse.of(dues.list(CallerHolder.require(), f, PageQuery.of(limit, offset)).map(DueResponse::of));
    }
    @GetMapping("/{id}")
    public ResponseEntity<DueResponse> get(@PathVariable UUID id) { return withTag(dues.get(CallerHolder.require(), new DueId(id)), 200); }

    @PostMapping
    public ResponseEntity<DueResponse> raise(@Valid @RequestBody RaiseDueRequest b, @RequestHeader(name = "Idempotency-Key", required = false) String key) {
        Caller c = CallerHolder.require();
        Idempotency.Reply<DueResponse> r = idempotency.run(c, key, "POST /api/v1/dues", b, DueResponse.class, 201, () -> DueResponse.of(dues.raise(c,
            new DueService.RaiseDue(new UnitId(b.unitId()), b.categoryCode(), b.billedMonth(), b.description(), b.amount(), b.dueDate()))));
        return ResponseEntity.status(r.status()).header("ETag", ETags.of(r.body().version())).body(r.body());
    }
    @PostMapping("/{id}/cancel")
    public ResponseEntity<DueResponse> cancel(@PathVariable UUID id, @Valid @RequestBody ReasonRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return withTag(dues.cancel(CallerHolder.require(), new DueId(id), b.reason(), ETags.require(ifMatch)), 200);
    }
    @PostMapping("/{id}/waive")
    public ResponseEntity<DueResponse> waive(@PathVariable UUID id, @Valid @RequestBody ReasonRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return withTag(dues.waive(CallerHolder.require(), new DueId(id), b.reason(), ETags.require(ifMatch)), 200);
    }
    private static ResponseEntity<DueResponse> withTag(Due d, int status) { return ResponseEntity.status(status).header("ETag", ETags.of(d.version())).body(DueResponse.of(d)); }
}
