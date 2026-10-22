package com.communityos.api.finance.application;

import com.communityos.api.billing.application.BillingDesk;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.finance.application.port.FinanceStore;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;

/**
 * The cash book: money in and out of the bank that is not a bill's payment. An entry is checked (taxes worked out from its base amount),
 * refused in a closed period, and posted to the journal as it is written. Money out above the community's approval limit is not recorded
 * directly - it waits for a second approver (a pay request). An entry's money is never edited and it is never deleted: it is reversed once,
 * by an entry pointing at it, and only while it is not matched to a bank line. Its words (description, heads, ITC) can be corrected.
 */
public final class CashBookService {
    /** What the input-credit check writes on a payment (src/lib/finance/itc.js ITC), plus the older manual words kept for rows already saved. */
    public static final List<String> ITC_STATUSES = List.of("Not checked", "Verified", "Check vendor GSTIN", "Invoice details missing", "Not found in GSTR-2B",
        "Not applicable", "Unregistered vendor", "Claimable", "Claimed", "Not claimable", "Mismatch");
    private final FinanceStore store; private final BillingDesk desk; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public CashBookService(FinanceStore store, BillingDesk desk, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.desk = desk; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    public List<Books.Entry> list(Caller c, FinanceStore.EntryFilter f) { requireReader(c); return store.entries(f); }
    public Books.Entry get(Caller c, UUID id) { requireReader(c); return store.entry(id).orElseThrow(AccessDenied.NotVisible::new); }

    /** An entry written by the accounts. Money out above the approval limit is refused with "needs-second-approver". */
    public Books.Entry record(Caller c, Books.Entry e) {
        requireWriter(c);
        e.check();
        // typed in by a person: money that moved through a bank carries its reference (how the statement line is found); cash, card and auto-debit need none
        if (e.mode != null && List.of("Bank transfer", "UPI", "Cheque", "Net banking").contains(e.mode) && (e.ref == null || e.ref.isBlank()))
            throw new DomainException.RuleViolated("reference-required", "Enter the " + ("Cheque".equals(e.mode) ? "cheque number" : "UTR / reference") + " - it is how the bank statement line is matched");
        var s = store.settings();
        if (e.debit() && s.approvalLimit() != null && s.approvalLimit().signum() > 0 && e.amount.compareTo(s.approvalLimit()) > 0)
            throw new DomainException.RuleViolated("needs-second-approver", "Payments above " + s.approvalLimit().toPlainString() + " need a second approver - send it as a pay request");
        return tx.inTx(() -> write(c, e, "Recorded"));
    }
    /** An entry another step already approved (a paid release, an approved pay request): no limit, the same lock and books. */
    public Books.Entry recordApproved(Caller c, Books.Entry e) {
        e.check();
        return write(c, e, "Recorded (approved)");
    }
    public Books.Entry reverse(Caller c, UUID id, long version, String reason) {
        requireWriter(c);
        if (reason == null || reason.isBlank()) throw new DomainException.RuleViolated("reason-required", "Say why the entry is reversed");
        return tx.inTx(() -> {
            Books.Entry e = store.entry(id).orElseThrow(AccessDenied.NotVisible::new);
            if (e.version != version) throw new DomainException.Conflict("Entry " + e.shortId);
            if (e.reversalOf != null) throw new DomainException.RuleViolated("is-reversal", "A reversal is not reversed - record the entry again");
            if (e.reversed) throw new DomainException.RuleViolated("reversed", "This entry is already reversed");
            if ("Matched".equals(e.reconStatus)) throw new DomainException.RuleViolated("matched", "This entry is matched to a bank line - unmatch it first");
            locked(e.date);
            Books.Entry r = e.reversal(LocalDate.now(clock), reason.strip());
            r.check();
            store.insert(r);
            desk.post(new Journal.Entry(r.date, "Reversal " + r.shortId + " of " + e.shortId, "cashbook", r.id, e.swapped()));
            if ("release".equals(e.sourceType) && e.sourceId != null) store.releaseUnpaid(e.sourceId);   // the release is approved, not paid, again
            audit.write(c, AuditWriter.Action.Create, "finance.cash_book_entry", r.id, r.shortId, r.unitId, "Reversed " + e.shortId + ": " + reason.strip(), List.of());
            return store.entry(r.id).orElseThrow();
        });
    }
    public Books.Entry annotate(Caller c, UUID id, long version, String description, String category, String subCategory, String itcStatus, String itcNote) {
        requireWriter(c);
        return tx.inTx(() -> {
            Books.Entry e = store.entry(id).orElseThrow(AccessDenied.NotVisible::new);
            if (e.version != version) throw new DomainException.Conflict("Entry " + e.shortId);
            if (description != null && !description.isBlank()) e.description = description.strip();
            e.category = category; e.subCategory = subCategory;
            if (itcStatus != null && !ITC_STATUSES.contains(itcStatus))
                throw new DomainException.RuleViolated("bad-itc", "ITC status: " + String.join(", ", ITC_STATUSES));
            e.itcStatus = itcStatus; e.itcNote = itcNote;
            if (!store.annotate(e)) throw new DomainException.Conflict("Entry " + e.shortId);
            audit.write(c, AuditWriter.Action.Update, "finance.cash_book_entry", e.id, e.shortId, e.unitId, "Details corrected", List.of());
            return store.entry(id).orElseThrow();
        });
    }
    /** Close the books up to a date (nothing on or before it is added, reversed or changed); moving it earlier reopens. */
    public FinanceStore.Settings lock(Caller c, LocalDate until, String reason) {
        requireWriter(c);
        return tx.inTx(() -> {
            LocalDate was = store.settings().lockedUntil();
            if (was != null && (until == null || until.isBefore(was)) && (reason == null || reason.isBlank())) throw new DomainException.RuleViolated("reason-required", "Say why the period is reopened");
            if (until != null && until.isAfter(LocalDate.now(clock))) throw new DomainException.RuleViolated("future", "The books close up to today at the latest");
            store.lock(until);
            audit.write(c, AuditWriter.Action.Update, "finance.finance_setting", null, null, null, until == null ? "Books reopened: " + reason : "Books closed up to " + until + (reason == null ? "" : " (" + reason + ")"), List.of());
            return store.settings();
        });
    }

    private Books.Entry write(Caller c, Books.Entry e, String what) {
        locked(e.date);
        e.reconStatus = "Unreconciled"; e.bankTxnId = null; e.internal = false; e.reversalOf = null;
        store.insert(e);
        desk.post(new Journal.Entry(e.date, (e.debit() ? "Paid: " : "Received: ") + e.description + " · " + e.shortId, "cashbook", e.id, e.lines()));
        audit.write(c, AuditWriter.Action.Create, "finance.cash_book_entry", e.id, e.shortId, e.unitId, what + " " + e.type.toLowerCase() + " " + e.amount.toPlainString() + " - " + e.description, List.of());
        return store.entry(e.id).orElseThrow();
    }
    private void locked(LocalDate date) {
        LocalDate until = store.settings().lockedUntil();
        if (until != null && date != null && !date.isAfter(until)) throw new DomainException.RuleViolated("books-closed", "The books are closed up to " + until + " - ask the Treasurer to reopen the period for a genuine correction");
    }
    static void requireReader(Caller c) { if (!FinancePolicy.reader(c)) throw new AccessDenied("The cash book is for the committee and the accounts"); }
    static void requireWriter(Caller c) { if (!FinancePolicy.writer(c)) throw new AccessDenied("Requires permission: MANAGE_LEDGER"); }
}
