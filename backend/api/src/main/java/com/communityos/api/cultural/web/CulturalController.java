package com.communityos.api.cultural.web;

import com.communityos.api.cultural.application.CulturalPolicy;
import com.communityos.api.cultural.application.DonationService;
import com.communityos.api.cultural.application.ExpenseService;
import com.communityos.api.cultural.application.SignupService;
import com.communityos.api.cultural.application.port.CulturalStore;
import com.communityos.api.cultural.domain.Cultural;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
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
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Donations, event expenses, the budget credit and sign-ups. The event registers themselves are the resource kit (/api/v1/cultural/...). */
@RestController
@Tag(name = "Cultural events")
public class CulturalController {
    /** A pledge or a donation; `received` (the committee only) records money received now. Receipts, status and the books are the server's. */
    public record DonationRequest(@NotNull UUID eventId, @Size(max = 120) String donor, UUID unitId, @Pattern(regexp = "Donation|Sponsorship|In-kind") String kind, @Size(max = 40) String towards,
                                  @NotNull BigDecimal amount, LocalDate date, @Size(max = 30) String mode, @Size(max = 100) String reference, Boolean anonymous, @Size(max = 2000) String note,
                                  @Size(max = 20) String phone, @Size(max = 2000) String members, @Size(max = 2000) String sankalpam, UUID offeringId, Boolean received) {
        DonationService.Pledge pledge() {
            return new DonationService.Pledge(eventId, donor, unitId, kind, towards, amount, date, mode, reference, Boolean.TRUE.equals(anonymous), note, phone, members, sankalpam, offeringId);
        }
    }
    public record ReceiveRequest(@NotNull @Size(max = 30) String mode, @Size(max = 100) String reference) {}
    public record OnlineRequest(@NotNull UUID prepaymentId) {}
    public record ExpenseRequest(@NotNull @Size(max = 200) String item, @Size(max = 60) String category, @Size(max = 200) String vendor, BigDecimal amount, BigDecimal estimate, LocalDate date,
                                 @Size(max = 60) String fund, @Size(max = 2000) String note) {
        ExpenseService.Fields fields() { return new ExpenseService.Fields(item, category, vendor, amount, estimate, date, fund, note); }
    }
    public record DecisionRequest(@NotNull @Pattern(regexp = "Approved|Rejected|Pending") String value, @Size(max = 2000) String comment, Boolean finish) {}
    public record PayRequest(@Size(max = 30) String mode) {}
    public record CreditRequest(@NotNull BigDecimal amount, @Size(max = 500) String note) {}
    public record SignupRequest(@Min(1) @Max(50) Integer people) {}

    public record DonationResponse(UUID id, String shortId, UUID eventId, String donor, UUID unitId, String unitNo, String kind, String towards, BigDecimal amount, LocalDate date,
                                   String mode, String reference, String status, String receiptNo, UUID offeringId, String phone, String members, String sankalpam, boolean anonymous,
                                   String note, String receivedBy, Instant receivedAt, UUID paymentId, Instant createdAt, long version) {
        static DonationResponse of(Cultural.Donation d) {
            return new DonationResponse(d.id, d.shortId, d.eventId, d.donor, d.unitId, d.unitNo, d.kind, d.towards, d.amount, d.date, d.mode, d.reference, d.status, d.receiptNo, d.offeringId,
                d.phone, d.members, d.sankalpam, d.anonymous, d.note, d.receivedBy, d.receivedAt, d.paymentId, d.createdAt, d.version);
        }
    }
    public record ExpenseResponse(UUID id, String shortId, UUID eventId, String item, String category, String vendor, BigDecimal amount, BigDecimal estimate, LocalDate date, String status,
                                  String fund, String plan, String note, String raisedBy, UUID raisedById, String ecApproval, String ecApprovedBy, Instant ecApprovedAt, String ecNote,
                                  Boolean finalRequired, String approvedBy, Instant approvedAt, String approvalNote, String paidBy, Instant paidAt, String paidMode, String whyNotMe,
                                  Instant createdAt, long version) {}
    public record SlotResponse(UUID id, UUID eventId, String title, int limit, int peoplePerUnit, List<Cultural.Signup> list) {
        static SlotResponse of(CulturalStore.Slot s) { return new SlotResponse(s.id(), s.eventId(), s.title(), s.limit(), s.peoplePerUnit(), s.list()); }
    }

    private final DonationService donations; private final ExpenseService expenses; private final SignupService signups; private final com.communityos.api.approval.application.PlanCodec plans;
    public CulturalController(DonationService donations, ExpenseService expenses, SignupService signups, com.communityos.api.approval.application.PlanCodec plans) {
        this.donations = donations; this.expenses = expenses; this.signups = signups; this.plans = plans;
    }

    // ---- donations -------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/cultural/donations")
    public List<DonationResponse> donations(@RequestParam(required = false) UUID eventId) { return donations.list(CallerHolder.require(), eventId).stream().map(DonationResponse::of).toList(); }
    @GetMapping("/api/v1/cultural/donations/{id}")
    public ResponseEntity<DonationResponse> donation(@PathVariable UUID id) { return tagged(donations.get(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/cultural/donations")
    public ResponseEntity<DonationResponse> give(@Valid @RequestBody DonationRequest b) {
        Caller c = CallerHolder.require();
        Cultural.Donation d = CulturalPolicy.manager(c) ? donations.record(c, b.pledge(), Boolean.TRUE.equals(b.received())) : donations.pledge(c, b.pledge());
        return ResponseEntity.status(201).header("ETag", ETags.of(d.version)).body(DonationResponse.of(d));
    }
    @PutMapping("/api/v1/cultural/donations/{id}")
    public ResponseEntity<DonationResponse> change(@PathVariable UUID id, @Valid @RequestBody DonationRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(donations.change(CallerHolder.require(), id, ETags.require(ifMatch), b.pledge()));
    }
    @DeleteMapping("/api/v1/cultural/donations/{id}")
    public ResponseEntity<Void> withdraw(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        donations.withdraw(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }
    @PostMapping("/api/v1/cultural/donations/{id}/receive")
    public ResponseEntity<DonationResponse> receive(@PathVariable UUID id, @Valid @RequestBody ReceiveRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(donations.receive(CallerHolder.require(), id, ETags.require(ifMatch), b.mode(), b.reference()));
    }
    @PostMapping("/api/v1/cultural/donations/{id}/paid-online")
    public ResponseEntity<DonationResponse> paidOnline(@PathVariable UUID id, @Valid @RequestBody OnlineRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(donations.paidOnline(CallerHolder.require(), id, ETags.require(ifMatch), b.prepaymentId()));
    }

    // ---- expenses and the budget -------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/cultural/expenses")
    public List<ExpenseResponse> expenses(@RequestParam(required = false) UUID eventId) {
        Caller c = CallerHolder.require();
        return expenses.list(c, eventId).stream().map((x) -> expense(c, x)).toList();
    }
    @GetMapping("/api/v1/cultural/expenses/{id}")
    public ExpenseResponse expense(@PathVariable UUID id) { Caller c = CallerHolder.require(); return expense(c, expenses.get(c, id)); }
    @PostMapping("/api/v1/cultural/events/{eventId}/expenses")
    public ResponseEntity<ExpenseResponse> raise(@PathVariable UUID eventId, @Valid @RequestBody ExpenseRequest b) {
        Caller c = CallerHolder.require();
        return ResponseEntity.status(201).body(expense(c, expenses.raise(c, eventId, b.fields())));
    }
    @PutMapping("/api/v1/cultural/expenses/{id}")
    public ExpenseResponse changeExpense(@PathVariable UUID id, @Valid @RequestBody ExpenseRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require();
        return expense(c, expenses.change(c, id, ETags.require(ifMatch), b.fields()));
    }
    @PostMapping("/api/v1/cultural/expenses/{id}/decision")
    public ExpenseResponse decide(@PathVariable UUID id, @Valid @RequestBody DecisionRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require();
        return expense(c, expenses.decide(c, id, ETags.require(ifMatch), b.value(), b.comment(), Boolean.TRUE.equals(b.finish())));
    }
    @PostMapping("/api/v1/cultural/expenses/{id}/pay")
    public ExpenseResponse pay(@PathVariable UUID id, @Valid @RequestBody PayRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require();
        return expense(c, expenses.pay(c, id, ETags.require(ifMatch), b.mode()));
    }
    @DeleteMapping("/api/v1/cultural/expenses/{id}")
    public ResponseEntity<Void> removeExpense(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        expenses.remove(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }
    @PostMapping("/api/v1/cultural/events/{id}/credit")
    public Cultural.Event credit(@PathVariable UUID id, @Valid @RequestBody CreditRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return expenses.credit(CallerHolder.require(), id, ETags.require(ifMatch), b.amount(), b.note());
    }

    // ---- sign-ups --------------------------------------------------------------------------------------------------------------------------------
    @PostMapping("/api/v1/cultural/{list}/{id}/signup")
    public SlotResponse signUp(@PathVariable String list, @PathVariable UUID id, @Valid @RequestBody SignupRequest b) {
        return SlotResponse.of(signups.signUp(CallerHolder.require(), which(list), id, b.people()));
    }
    @DeleteMapping("/api/v1/cultural/{list}/{id}/signup")
    public SlotResponse leave(@PathVariable String list, @PathVariable UUID id, @RequestParam(required = false) UUID membershipId) {
        return SlotResponse.of(signups.withdraw(CallerHolder.require(), which(list), id, membershipId));
    }

    static CulturalStore.List_ which(String list) {
        return switch (list) { case "seva" -> CulturalStore.List_.SEVA; case "programme" -> CulturalStore.List_.PROGRAM;
            default -> throw new com.communityos.api.shared.domain.DomainException.RuleViolated("bad-list", "seva or programme"); };
    }
    ExpenseResponse expense(Caller c, Cultural.Expense x) {
        return new ExpenseResponse(x.id, x.shortId, x.eventId, x.item, x.category, x.vendor, x.amount, x.estimate, x.date, x.status, x.fund, plans.write(x.plan), x.note, x.raisedBy, x.raisedById,
            x.ecApproval, x.ecApprovedBy, x.ecApprovedAt, x.ecNote, x.finalRequired, x.approvedBy, x.approvedAt, x.approvalNote, x.paidBy, x.paidAt, x.paidMode, expenses.whyNot(c, x), x.createdAt, x.version);
    }
    private static ResponseEntity<DonationResponse> tagged(Cultural.Donation d) { return ResponseEntity.ok().header("ETag", ETags.of(d.version)).body(DonationResponse.of(d)); }
}
