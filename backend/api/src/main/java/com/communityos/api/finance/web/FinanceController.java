package com.communityos.api.finance.web;

import com.communityos.api.approval.application.PlanCodec;
import com.communityos.api.finance.application.BankService;
import com.communityos.api.finance.application.CashBookService;
import com.communityos.api.finance.application.PayRequestService;
import com.communityos.api.finance.application.ReleaseService;
import com.communityos.api.finance.application.port.FinanceStore;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
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
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The cash book, releases, pay requests, bank statements, the closed-books date and the ledger. The finance registers are the resource kit. */
@RestController
@Tag(name = "Finance")
public class FinanceController {
    /** A cash book entry as the accounts write it. GST and TDS amounts (and the bank amount, when a base is given) are worked out by the server. */
    public record EntryRequest(@NotNull LocalDate date, @Size(max = 80) String account, @NotBlank @Size(max = 500) String description, @Size(max = 80) String category,
                               @Size(max = 80) String subCategory, @NotNull @Pattern(regexp = "Debit|Credit") String type, BigDecimal amount, @Size(max = 200) String vendor,
                               @Size(max = 40) String taskRef, @Size(max = 200) String noTask, @Size(max = 40) String module, @Size(max = 40) String sourceType, @Size(max = 200) String sourceLabel,
                               UUID sourceId, @Size(max = 30) String mode, @Size(max = 100) String ref, UUID unitId, @Size(max = 40) String bookingNo, @Size(max = 60) String invoiceNo,
                               @Size(max = 60) String billNo, BigDecimal baseAmount, BigDecimal gstRate, @Size(max = 20) String tdsSection, BigDecimal tdsRate, @Size(max = 60) String fund,
                               @Size(max = 30) String itcStatus, @Size(max = 500) String itcNote) {
        Books.Entry entry() {
            // money the server books itself (bill payments, bookings, donations, releases, reversals) is never typed in: it would count twice or fake its origin
            if (sourceType != null && List.of("release", "reversal", "due", "duePayment", "booking", "donation", "payment").contains(sourceType))
                throw new DomainException.RuleViolated("bad-source", "That kind of entry is written by the server");
            Books.Entry e = new Books.Entry();
            e.date = date; e.account = account; e.description = description; e.category = category; e.subCategory = subCategory; e.type = type; e.amount = amount; e.vendor = vendor;
            e.taskRef = taskRef; e.noTask = noTask; e.module = module; e.sourceType = sourceType; e.sourceLabel = sourceLabel; e.sourceId = sourceId; e.mode = mode; e.ref = ref; e.unitId = unitId;
            e.bookingNo = bookingNo; e.invoiceNo = invoiceNo; e.billNo = billNo; e.baseAmount = baseAmount; e.gstRate = gstRate; e.tdsSection = tdsSection; e.tdsRate = tdsRate; e.fund = fund;
            e.itcStatus = itcStatus; e.itcNote = itcNote;
            return e;
        }
    }
    public record ReverseRequest(@NotBlank @Size(max = 500) String reason) {}
    public record AnnotateRequest(@Size(max = 500) String description, @Size(max = 80) String category, @Size(max = 80) String subCategory, @Size(max = 30) String itcStatus, @Size(max = 500) String itcNote) {}
    public record StatementRequest(@NotNull Boolean notApplicable) {}
    public record ReleaseRequest(UUID ticketId, UUID expenseId, @Size(max = 30) String kind, @NotNull BigDecimal amount, @Size(max = 200) String vendor, @Size(max = 2000) String note) {}
    public record ReleaseChange(@Size(max = 30) String kind, BigDecimal amount, @Size(max = 200) String vendor, @Size(max = 2000) String note) {}
    public record DecisionRequest(@NotNull @Pattern(regexp = "Approved|Rejected|Pending") String value, @Size(max = 2000) String comment, Boolean finish) {}
    public record PayRequestBody(@Size(max = 30) String mode, @Size(max = 100) String ref, LocalDate date) {}
    public record CancelRequest(@NotBlank @Size(max = 500) String reason) {}
    public record PayDecision(@NotNull Boolean approve, @Size(max = 500) String note) {}
    public record LineIn(@NotNull LocalDate date, @Size(max = 500) String narration, @Size(max = 80) String head, BigDecimal debit, BigDecimal credit, BigDecimal balance, @Size(max = 200) String party,
                         @Size(max = 500) String remarks) {}
    public record ImportRequest(@NotBlank @Size(max = 80) String account, @NotNull @Size(min = 1, max = 5000) List<@Valid LineIn> lines) {}
    public record MatchRequest(@NotNull UUID entryId) {}
    public record LockRequest(LocalDate until, @Size(max = 500) String reason) {}

    public record ReleaseResponse(UUID id, String shortId, UUID ticketId, String ticketShortId, UUID expenseId, String kind, BigDecimal amount, String vendor, String note, String status,
                                  String cancelReason, Instant cancelledAt, String raisedBy, UUID raisedById, String plan, Instant paidAt, UUID paidEntryId, String whyNotMe, Instant createdAt, long version) {}

    private final CashBookService cash; private final ReleaseService releases; private final PayRequestService payRequests; private final BankService bank; private final FinanceStore store;
    private final PlanCodec plans;
    public FinanceController(CashBookService cash, ReleaseService releases, PayRequestService payRequests, BankService bank, FinanceStore store, PlanCodec plans) {
        this.cash = cash; this.releases = releases; this.payRequests = payRequests; this.bank = bank; this.store = store; this.plans = plans;
    }

    // ---- the cash book -------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/finance/cash-book")
    public List<Books.Entry> entries(@RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to, @RequestParam(required = false) String module,
                                     @RequestParam(required = false) String recon, @RequestParam(required = false) String taskRef, @RequestParam(required = false) UUID sourceId) {
        return cash.list(CallerHolder.require(), new FinanceStore.EntryFilter(from, to, module, recon, taskRef, sourceId));
    }
    @GetMapping("/api/v1/finance/cash-book/{id}")
    public Books.Entry entry(@PathVariable UUID id) { return cash.get(CallerHolder.require(), id); }
    @PostMapping("/api/v1/finance/cash-book")
    public ResponseEntity<Books.Entry> record(@Valid @RequestBody EntryRequest b) { return ResponseEntity.status(201).body(cash.record(CallerHolder.require(), b.entry())); }
    @PostMapping("/api/v1/finance/cash-book/{id}/reverse")
    public ResponseEntity<Books.Entry> reverse(@PathVariable UUID id, @Valid @RequestBody ReverseRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return ResponseEntity.status(201).body(cash.reverse(CallerHolder.require(), id, ETags.require(ifMatch), b.reason()));
    }
    @PatchMapping("/api/v1/finance/cash-book/{id}")
    public Books.Entry annotate(@PathVariable UUID id, @Valid @RequestBody AnnotateRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return cash.annotate(CallerHolder.require(), id, ETags.require(ifMatch), b.description(), b.category(), b.subCategory(), b.itcStatus(), b.itcNote());
    }
    @PostMapping("/api/v1/finance/cash-book/{id}/statement")
    public Books.Entry statement(@PathVariable UUID id, @Valid @RequestBody StatementRequest b) { return bank.notOnStatement(CallerHolder.require(), id, b.notApplicable()); }
    @PutMapping("/api/v1/finance/period-lock")
    public FinanceStore.Settings lock(@Valid @RequestBody LockRequest b) { return cash.lock(CallerHolder.require(), b.until(), b.reason()); }

    // ---- releases ------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/finance/releases")
    public List<ReleaseResponse> releases(@RequestParam(required = false) UUID ticketId, @RequestParam(required = false) UUID expenseId) {
        Caller c = CallerHolder.require();
        return releases.list(c, ticketId, expenseId).stream().map((r) -> release(c, r)).toList();
    }
    @GetMapping("/api/v1/finance/releases/{id}")
    public ReleaseResponse release(@PathVariable UUID id) { Caller c = CallerHolder.require(); return release(c, releases.get(c, id)); }
    @PostMapping("/api/v1/finance/releases")
    public ResponseEntity<ReleaseResponse> raise(@Valid @RequestBody ReleaseRequest b) {
        Caller c = CallerHolder.require();
        return ResponseEntity.status(201).body(release(c, releases.raise(c, new ReleaseService.NewRelease(b.ticketId(), b.expenseId(), b.kind(), b.amount(), b.vendor(), b.note()))));
    }
    @PutMapping("/api/v1/finance/releases/{id}")
    public ReleaseResponse change(@PathVariable UUID id, @Valid @RequestBody ReleaseChange b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require();
        return release(c, releases.change(c, id, ETags.require(ifMatch), b.kind(), b.amount(), b.vendor(), b.note()));
    }
    @PostMapping("/api/v1/finance/releases/{id}/decision")
    public ReleaseResponse decide(@PathVariable UUID id, @Valid @RequestBody DecisionRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require();
        return release(c, releases.decide(c, id, ETags.require(ifMatch), b.value(), b.comment(), Boolean.TRUE.equals(b.finish())));
    }
    @PostMapping("/api/v1/finance/releases/{id}/pay")
    public ReleaseResponse pay(@PathVariable UUID id, @Valid @RequestBody PayRequestBody b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require();
        return release(c, releases.pay(c, id, ETags.require(ifMatch), b.mode(), b.ref(), b.date()));
    }
    @PostMapping("/api/v1/finance/releases/{id}/cancel")
    public ReleaseResponse cancel(@PathVariable UUID id, @Valid @RequestBody CancelRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Caller c = CallerHolder.require();
        return release(c, releases.cancel(c, id, ETags.require(ifMatch), b.reason()));
    }

    // ---- pay requests --------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/finance/pay-requests")
    public List<Books.PayRequest> payRequests(@RequestParam(required = false) String status) { return payRequests.list(CallerHolder.require(), status); }
    @PostMapping("/api/v1/finance/pay-requests")
    public ResponseEntity<Books.PayRequest> submit(@Valid @RequestBody EntryRequest b) { return ResponseEntity.status(201).body(payRequests.submit(CallerHolder.require(), b.entry())); }
    @PostMapping("/api/v1/finance/pay-requests/{id}/decision")
    public Books.PayRequest decidePay(@PathVariable UUID id, @Valid @RequestBody PayDecision b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return payRequests.decide(CallerHolder.require(), id, ETags.require(ifMatch), b.approve(), b.note());
    }

    // ---- the bank ------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/finance/bank-lines")
    public List<Books.BankLine> lines(@RequestParam(required = false) String account, @RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to,
                                      @RequestParam(required = false) Boolean unmatched) {
        return bank.lines(CallerHolder.require(), new FinanceStore.LineFilter(account, from, to, unmatched));
    }
    @PostMapping("/api/v1/finance/bank-lines/import")
    public BankService.Imported importLines(@Valid @RequestBody ImportRequest b) {
        return bank.importLines(CallerHolder.require(), b.account(), b.lines().stream().map((l) -> new Books.BankLine(null, null, l.date(), b.account(), l.narration(), l.head(), l.debit(), l.credit(),
            l.balance(), l.party(), l.remarks(), null, 0)).toList());
    }
    @PostMapping("/api/v1/finance/bank-lines/{id}/match")
    public Books.BankLine match(@PathVariable UUID id, @Valid @RequestBody MatchRequest b) { return bank.match(CallerHolder.require(), id, b.entryId()); }
    @PostMapping("/api/v1/finance/bank-lines/{id}/unmatch")
    public Books.BankLine unmatch(@PathVariable UUID id) { return bank.unmatch(CallerHolder.require(), id); }

    // ---- the ledger ----------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/finance/ledger/accounts")
    public List<FinanceStore.AccountBalance> accounts() { requireBooks(); return store.accounts(); }
    @GetMapping("/api/v1/finance/ledger/journal")
    public List<FinanceStore.JournalEntry> journal(@RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to, @RequestParam(required = false) String account) {
        requireBooks(); return store.journal(from, to, account);
    }

    static void requireBooks() {
        Caller c = CallerHolder.require();
        if (!com.communityos.api.finance.application.FinancePolicy.reader(c)) throw new com.communityos.api.shared.security.AccessDenied("The ledger is for the committee and the accounts");
    }
    ReleaseResponse release(Caller c, Books.Release r) {
        return new ReleaseResponse(r.id, r.shortId, r.ticketId, r.ticketShortId, r.expenseId, r.kind, r.amount, r.vendor, r.note, r.status, r.cancelReason, r.cancelledAt, r.raisedBy, r.raisedById,
            plans.write(r.plan), r.paidAt, r.paidEntryId, releases.whyNot(c, r), r.createdAt, r.version);
    }
}
