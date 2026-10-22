package com.communityos.api.finance.application;

import com.communityos.api.finance.application.port.FinanceStore;
import com.communityos.api.finance.application.port.PayoutStore;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Provider payouts against the bank statement. The payment provider pays the online payments of a few days into the bank in one amount,
 * less its fees. A money-in bank line is matched to the online payments it carries: the treasurer picks them, or the server proposes the
 * oldest payments that add up to the line with fees of at most 5 %. Matching writes one cash book entry (Dr bank / Dr provider fees /
 * Cr gateway clearing), matches it to the line and marks each payment as paid out - all in one transaction; a payment goes into one payout.
 */
public final class PayoutService {
    public static final BigDecimal MAX_FEE_PCT = new BigDecimal("5");
    public record Proposal(UUID lineId, BigDecimal lineAmount, BigDecimal paymentsTotal, BigDecimal fees, List<PayoutStore.OnlinePayment> payments, boolean fits) {}

    private final PayoutStore payouts; private final FinanceStore store; private final CashBookService cash; private final BankService bank; private final AuditWriter audit; private final Tx tx;
    public PayoutService(PayoutStore payouts, FinanceStore store, CashBookService cash, BankService bank, AuditWriter audit, Tx tx) {
        this.payouts = payouts; this.store = store; this.cash = cash; this.bank = bank; this.audit = audit; this.tx = tx;
    }

    /** Online payments not yet paid out up to the line's date, and the server's pick for it (empty when nothing fits). */
    public Proposal propose(Caller c, UUID lineId) {
        CashBookService.requireWriter(c);
        Books.BankLine l = line(lineId);
        List<PayoutStore.OnlinePayment> open = payouts.unsettled(l.date());
        List<PayoutStore.OnlinePayment> pick = new ArrayList<>(); BigDecimal sum = BigDecimal.ZERO;
        for (PayoutStore.OnlinePayment p : open) {
            pick.add(p); sum = sum.add(p.amount());
            if (sum.compareTo(l.credit()) >= 0) break;
        }
        boolean fits = sum.compareTo(l.credit()) >= 0 && feeOk(sum, l.credit());
        return new Proposal(lineId, l.credit(), fits ? sum : BigDecimal.ZERO, fits ? sum.subtract(l.credit()) : BigDecimal.ZERO, fits ? pick : open, fits);
    }

    /** Match the line to these online payments (as proposed, or as the treasurer chose them). */
    public Books.BankLine match(Caller c, UUID lineId, List<UUID> paymentIds) {
        CashBookService.requireWriter(c);
        if (paymentIds == null || paymentIds.isEmpty() || paymentIds.size() > 2000) throw new DomainException.RuleViolated("payments-required", "Choose the online payments this payout carries");
        return tx.inTx(() -> {
            Books.BankLine l = line(lineId);
            List<PayoutStore.OnlinePayment> got = payouts.lock(paymentIds);
            if (got.size() != new java.util.HashSet<>(paymentIds).size()) throw new DomainException.RuleViolated("payment-taken", "Some of these payments are already in a payout, or were not paid online");
            BigDecimal gross = got.stream().map(PayoutStore.OnlinePayment::amount).reduce(BigDecimal.ZERO, BigDecimal::add);
            if (gross.compareTo(l.credit()) < 0) throw new DomainException.RuleViolated("payout-short", "These payments add up to " + gross.toPlainString() + ", less than the " + l.credit().toPlainString() + " that arrived");
            if (!feeOk(gross, l.credit())) throw new DomainException.RuleViolated("fees-too-high", "That would be " + gross.subtract(l.credit()).toPlainString() + " of fees, more than " + MAX_FEE_PCT + " % - check the payments");
            Books.Entry e = new Books.Entry();
            e.date = l.date(); e.account = l.account(); e.type = "Credit"; e.amount = l.credit(); e.baseAmount = gross; e.sourceType = Books.Entry.PAYOUT; e.mode = "Bank transfer";
            e.description = "Payout from " + got.get(0).provider() + ": " + got.size() + " online payment" + (got.size() == 1 ? "" : "s") + " (" + got.get(0).receiptNo() + (got.size() > 1 ? " … " + got.get(got.size() - 1).receiptNo() : "") + ")";
            e.ref = l.narration() == null ? null : l.narration().substring(0, Math.min(100, l.narration().length())); e.module = "Dues";
            Books.Entry entry = cash.recordApproved(c, e);
            payouts.settled(paymentIds, entry.id);
            Books.BankLine matched = bank.match(c, lineId, entry.id);
            audit.write(c, AuditWriter.Action.Update, "finance.bank_txn", lineId, l.shortId(), null, "Payout matched: " + got.size() + " payments " + gross.toPlainString() + ", fees " + gross.subtract(l.credit()).toPlainString(), List.of());
            return matched;
        });
    }

    static boolean feeOk(BigDecimal gross, BigDecimal net) {
        BigDecimal fee = gross.subtract(net);
        return fee.signum() >= 0 && fee.compareTo(gross.multiply(MAX_FEE_PCT).divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP)) <= 0;
    }
    private Books.BankLine line(UUID id) {
        Books.BankLine l = store.bankLine(id).orElseThrow(AccessDenied.NotVisible::new);
        if (l.out()) throw new DomainException.RuleViolated("not-money-in", "A payout is money coming in");
        if (l.matchedEntryId() != null) throw new DomainException.RuleViolated("line-matched", "This bank line is already matched");
        return l;
    }
}
