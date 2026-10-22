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
    private final DueService dues; private final com.communityos.api.billing.application.LateFeeService lateFees;
    public DueController(DueService dues, com.communityos.api.billing.application.LateFeeService lateFees) { this.dues = dues; this.lateFees = lateFees; }

    /** Late fees due today and not yet charged (nothing is charged). */
    @GetMapping("/api/v1/dues/late-fees")
    public com.communityos.api.billing.application.LateFeeService.Run lateFeePreview() { return lateFees.preview(CallerHolder.require()); }
    /** Charge them: one fee bill per overdue bill per month, never twice. */
    @PostMapping("/api/v1/dues/late-fees")
    public com.communityos.api.billing.application.LateFeeService.Run applyLateFees() { return lateFees.apply(CallerHolder.require(), false); }

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
    public ResponseEntity<DueResponse> raise(@Valid @RequestBody RaiseDueRequest b) {
        Caller c = CallerHolder.require();
        DueResponse r = DueResponse.of(dues.raise(c,
            new DueService.RaiseDue(new UnitId(b.unitId()), b.categoryCode(), b.billedMonth(), b.description(), b.amount(), b.dueDate())));
        return ResponseEntity.status(201).header("ETag", ETags.of(r.version())).body(r);
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
