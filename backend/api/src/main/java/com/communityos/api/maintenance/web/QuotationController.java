package com.communityos.api.maintenance.web;

import com.communityos.api.approval.application.Approvers;
import com.communityos.api.approval.domain.Plan;
import com.communityos.api.maintenance.application.QuotationService;
import com.communityos.api.maintenance.application.port.TaskMoney;
import com.communityos.api.maintenance.application.WishVotes;
import com.communityos.api.maintenance.domain.Quotation;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.fasterxml.jackson.databind.JsonNode;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Quotations and invoices on tasks, their approvals, and the money position of a task. Wish votes. */
@RestController
@Tag(name = "Maintenance")
public class QuotationController {
    /** What a caller may send to add a document: what is written on it. Amounts, approvals and selection are the server's. */
    public record AddDocumentRequest(@NotNull @Pattern(regexp = "Quotation|Invoice") String kind, @Size(max = 200) String vendor, @NotNull BigDecimal amount,
                                     @Pattern(regexp = "None|Included|Extra") String gstMode, BigDecimal gstRate, LocalDate quoteDate, @Size(max = 4000) String note) {}
    public record DecisionRequest(@NotNull @Pattern(regexp = "Approved|Rejected|Pending") String value, @Size(max = 2000) String comment, Boolean finish) {}
    public record SendBackRequest(@NotBlank @Size(max = 2000) String note) {}
    public record VoteRequest(@NotNull Boolean vote) {}

    public record QuotationResponse(UUID id, String shortId, UUID ticketId, String kind, String vendor, Money baseAmount, String gstMode, BigDecimal gstRate, Money gstAmount,
                                    Money amount, LocalDate quoteDate, String note, boolean selected, boolean overBudget, boolean approvalWaived, String correctionNote,
                                    String status, String approvalKey, String ecApproval, UUID ecApprovedById, String ecApprovedBy, Instant ecApprovedAt, boolean finalRequired,
                                    String finalApproval, UUID finalApprovedById, String finalApprovedBy, Instant finalApprovedAt, Plan plan, String waitingFor, String whyNotMe, UUID createdById, String createdByName,
                                    Instant createdAt, Instant updatedAt, long version) {
        static QuotationResponse of(Quotation q, String whyNot) {
            Quotation.State s = q.state();
            Plan.Position p = s.plan == null ? null : s.plan.position();
            String waiting = p != null && p.state() == Plan.State.PENDING && q.selected() && !s.approvalWaived ? p.step().name() + " - " + Approvers.who(p.step()) : null;
            Plan.Slots sl = s.plan == null ? null : s.plan.slots();
            String ecBy = sl == null || sl.ecLast() == null ? null : sl.ecLast().name(), finBy = sl == null || sl.finLast() == null ? null : sl.finLast().name();
            return new QuotationResponse(s.id, s.shortId, s.ticketId, s.kind, s.vendor, s.baseAmount, s.gstMode, s.gstRate, s.gstAmount, s.amount, s.quoteDate, s.note, s.selected,
                s.overBudget, s.approvalWaived, s.correctionNote, q.status(), q.approvalKey(), s.ecApproval, s.ecApprovedBy, ecBy, s.ecApprovedAt, s.finalRequired, s.finalApproval,
                s.finalApprovedBy, finBy, s.finalApprovedAt, s.plan, waiting, whyNot, s.createdBy, s.createdByName, s.createdAt, s.updatedAt, s.version);
        }
    }

    private final QuotationService docs; private final WishVotes votes;
    public QuotationController(QuotationService docs, WishVotes votes) { this.docs = docs; this.votes = votes; }

    @GetMapping("/api/v1/tickets/{id}/quotations")
    public List<QuotationResponse> ofTicket(@PathVariable UUID id) { Caller c = CallerHolder.require(); return docs.ofTicket(c, id).stream().map((q) -> out(c, q)).toList(); }
    @GetMapping("/api/v1/quotations")
    public List<QuotationResponse> all() { Caller c = CallerHolder.require(); return docs.all(c).stream().map((q) -> out(c, q)).toList(); }
    @GetMapping("/api/v1/quotations/{id}")
    public ResponseEntity<QuotationResponse> get(@PathVariable UUID id) { Caller c = CallerHolder.require(); return tagged(out(c, docs.get(c, id))); }
    @GetMapping("/api/v1/tickets/{id}/money")
    public TaskMoney.Position money(@PathVariable UUID id) { return docs.position(CallerHolder.require(), id); }

    @PostMapping("/api/v1/tickets/{id}/quotations")
    public ResponseEntity<QuotationResponse> add(@PathVariable UUID id, @Valid @RequestBody AddDocumentRequest b) {
        Caller c = CallerHolder.require();
        QuotationResponse r = out(c, docs.add(c, id, new QuotationService.AddDocument(b.kind(), b.vendor(), b.amount(), b.gstMode(), b.gstRate(), b.quoteDate(), b.note())));
        return ResponseEntity.status(201).header("ETag", ETags.of(r.version())).body(r);
    }
    @PostMapping("/api/v1/quotations/{id}/select")
    public ResponseEntity<QuotationResponse> select(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require(); return tagged(out(c, docs.select(c, id, ETags.require(ifMatch))));
    }
    @PostMapping("/api/v1/quotations/{id}/decision")
    public ResponseEntity<QuotationResponse> decide(@PathVariable UUID id, @Valid @RequestBody DecisionRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require();
        return tagged(out(c, docs.decide(c, id, ETags.require(ifMatch), b.value(), b.comment(), Boolean.TRUE.equals(b.finish()))));
    }
    @PostMapping("/api/v1/quotations/{id}/send-back")
    public ResponseEntity<QuotationResponse> sendBack(@PathVariable UUID id, @Valid @RequestBody SendBackRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require(); return tagged(out(c, docs.sendBack(c, id, ETags.require(ifMatch), b.note())));
    }
    @DeleteMapping("/api/v1/quotations/{id}")
    public ResponseEntity<Void> remove(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        docs.remove(CallerHolder.require(), id, ETags.require(ifMatch)); return ResponseEntity.noContent().build();
    }

    @PostMapping("/api/v1/maintenance/wishes/{id}/vote")
    public JsonNode vote(@PathVariable UUID id, @Valid @RequestBody VoteRequest b) { return votes.vote(CallerHolder.require(), id, b.vote()); }

    private QuotationResponse out(Caller c, Quotation q) { return QuotationResponse.of(q, docs.whyNot(c, q)); }
    private static ResponseEntity<QuotationResponse> tagged(QuotationResponse r) { return ResponseEntity.ok().header("ETag", ETags.of(r.version())).body(r); }
}
