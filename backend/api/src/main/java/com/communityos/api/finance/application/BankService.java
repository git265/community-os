package com.communityos.api.finance.application;

import com.communityos.api.finance.application.port.FinanceStore;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * Bank statements: lines are imported (a line already imported is skipped, so the same statement can be loaded twice) and each is matched to
 * at most one cash book entry going the same way for the same amount. An entry that will never be on a statement is marked "Not applicable".
 */
public final class BankService {
    static final BigDecimal TOLERANCE = new BigDecimal("1.00");
    private final FinanceStore store; private final AuditWriter audit; private final Tx tx;
    public BankService(FinanceStore store, AuditWriter audit, Tx tx) { this.store = store; this.audit = audit; this.tx = tx; }

    public List<Books.BankLine> lines(Caller c, FinanceStore.LineFilter f) { requireBank(c); return store.bankLines(f); }

    public record Imported(int added, int skipped) {}
    public Imported importLines(Caller c, String account, List<Books.BankLine> lines) {
        CashBookService.requireWriter(c);
        if (account == null || account.isBlank()) throw new DomainException.RuleViolated("account-required", "Which bank account is the statement of?");
        if (lines.isEmpty() || lines.size() > 5000) throw new DomainException.RuleViolated("bad-size", "A statement has 1 to 5000 lines");
        for (Books.BankLine l : lines) {
            if (l.date() == null) throw new DomainException.RuleViolated("date-required", "Every line needs its date");
            BigDecimal d = l.debit() == null ? BigDecimal.ZERO : l.debit(), cr = l.credit() == null ? BigDecimal.ZERO : l.credit();
            if (d.signum() < 0 || cr.signum() < 0 || (d.signum() > 0) == (cr.signum() > 0)) throw new DomainException.RuleViolated("bad-line", "Each line is money out or money in: " + l.narration());
        }
        return tx.inTx(() -> {
            int n = store.importLines(lines.stream().map((l) -> new Books.BankLine(null, null, l.date(), account.strip(), l.narration(), l.head(), l.debit(), l.credit(), l.balance(), l.party(), l.remarks(), null, 0)).toList());
            audit.write(c, AuditWriter.Action.Create, "finance.bank_txn", null, null, null, "Imported " + n + " statement lines for " + account + " (" + (lines.size() - n) + " already there)", List.of());
            return new Imported(n, lines.size() - n);
        });
    }
    public Books.BankLine match(Caller c, UUID lineId, UUID entryId) {
        CashBookService.requireWriter(c);
        return tx.inTx(() -> {
            Books.BankLine l = store.bankLine(lineId).orElseThrow(AccessDenied.NotVisible::new);
            Books.Entry e = store.entry(entryId).orElseThrow(AccessDenied.NotVisible::new);
            if (l.matchedEntryId() != null) throw new DomainException.RuleViolated("line-matched", "This bank line is already matched");
            if (e.bankTxnId != null) throw new DomainException.RuleViolated("entry-matched", "This entry is already matched to a bank line");
            if (l.out() != e.debit()) throw new DomainException.RuleViolated("wrong-way", "The bank line and the entry go different ways (in / out)");
            if (l.value().subtract(e.amount).abs().compareTo(TOLERANCE) > 0) throw new DomainException.RuleViolated("amount-differs", "The amounts differ (" + l.value().toPlainString() + " / " + e.amount.toPlainString() + ")");
            if (!store.match(lineId, entryId) || !store.setRecon(entryId, "Matched", lineId)) throw new DomainException.Conflict("Bank line");
            audit.write(c, AuditWriter.Action.Update, "finance.bank_txn", lineId, l.shortId(), null, "Matched to " + e.shortId, List.of());
            return store.bankLine(lineId).orElseThrow();
        });
    }
    public Books.BankLine unmatch(Caller c, UUID lineId) {
        CashBookService.requireWriter(c);
        return tx.inTx(() -> {
            Books.BankLine l = store.bankLine(lineId).orElseThrow(AccessDenied.NotVisible::new);
            if (l.matchedEntryId() == null) return l;
            store.setRecon(l.matchedEntryId(), "Unreconciled", null);
            store.unmatch(lineId);
            audit.write(c, AuditWriter.Action.Update, "finance.bank_txn", lineId, l.shortId(), null, "Unmatched", List.of());
            return store.bankLine(lineId).orElseThrow();
        });
    }
    /** An entry that will not appear on a bank statement (cash, an internal transfer) - or back to waiting. */
    public Books.Entry notOnStatement(Caller c, UUID entryId, boolean notApplicable) {
        CashBookService.requireWriter(c);
        return tx.inTx(() -> {
            Books.Entry e = store.entry(entryId).orElseThrow(AccessDenied.NotVisible::new);
            if ("Matched".equals(e.reconStatus)) throw new DomainException.RuleViolated("matched", "Unmatch it first");
            store.setRecon(entryId, notApplicable ? "Not applicable" : "Unreconciled", null);
            return store.entry(entryId).orElseThrow();
        });
    }
    static void requireBank(Caller c) { if (!(c.isSuperAdmin() || c.isCommittee() || FinancePolicy.writer(c))) throw new AccessDenied("Bank statements are for the committee and the accounts"); }
}
