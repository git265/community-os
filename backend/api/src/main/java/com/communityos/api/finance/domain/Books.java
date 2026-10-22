package com.communityos.api.finance.domain;

import com.communityos.api.approval.domain.Plan;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Money;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * The community's own money outside bills: cash book entries (and the journal lines they post), releases, pay requests, bank lines.
 * Money on an entry: gross = base + GST; the bank moves gross - TDS (the "amount"); a vendor's TDS is owed to the tax department.
 */
public final class Books {
    private Books() {}
    public static final List<String> MODULES = List.of("Maintenance", "Cultural", "Utilities", "Amenities", "Dues", "Capex / projects", "Other");
    public static final List<String> MODES = List.of("Bank transfer", "UPI", "Cheque", "Cash", "Card", "Net banking", "Auto debit");
    public static final BigDecimal MAX = new BigDecimal("100000000");

    public static final class Entry {
        public UUID id; public String shortId; public LocalDate date; public String account; public String description; public String category; public String subCategory;
        public String type; public BigDecimal amount; public String vendor; public String taskRef; public String noTask; public String module; public String sourceType;
        public String sourceLabel; public UUID sourceId; public String mode; public String ref; public UUID unitId; public String unitNo; public String bookingNo; public String invoiceNo;
        public String billNo; public BigDecimal baseAmount; public BigDecimal gstRate; public BigDecimal gstAmount; public String tdsSection; public BigDecimal tdsRate; public BigDecimal tdsAmount;
        public String fund; public String itcStatus; public String itcNote; public boolean internal; public String reversalOf; public String reason; public String reconStatus = "Unreconciled";
        public UUID bankTxnId; public UUID enteredById; public String enteredBy; public boolean reversed; public Instant createdAt; public long version;

        public boolean debit() { return "Debit".equals(type); }
        public static final String PAYOUT = "settlement";
        public boolean payout() { return PAYOUT.equals(sourceType); }
        /** Check the entry and work out its taxes: with a base amount, GST and TDS come from their rates and the amount is what the bank moves. */
        public void check() {
            rule(date != null, "date-required", "When was the money paid or received?");
            rule("Debit".equals(type) || "Credit".equals(type), "bad-type", "Money out (Debit) or in (Credit)");
            rule(description != null && !description.isBlank(), "description-required", "What is it for?");
            description = description.strip();
            rule(description.length() <= 500, "too-long", "Keep the description to 500 characters");
            rule(module == null || MODULES.contains(module), "bad-module", "Module: " + String.join(", ", MODULES));
            rule(gstRate == null || (gstRate.signum() >= 0 && gstRate.compareTo(BigDecimal.valueOf(40)) <= 0), "bad-gst", "GST rate 0 to 40 %");
            rule(tdsRate == null || (tdsRate.signum() >= 0 && tdsRate.compareTo(BigDecimal.valueOf(30)) <= 0), "bad-tds", "TDS rate 0 to 30 %");
            if (payout()) {          // a provider payout: baseAmount is what the payments brought in, amount what reached the bank, the rest the provider's fees
                rule(!debit() && amount != null && amount.signum() > 0 && baseAmount != null && baseAmount.compareTo(amount) >= 0, "bad-payout", "A payout is money in, at most what its payments brought in");
                amount = r2(amount); baseAmount = r2(baseAmount); gstAmount = BigDecimal.ZERO; tdsAmount = BigDecimal.ZERO; gstRate = null; tdsRate = null; tdsSection = null;
                return;
            }
            if (baseAmount != null && baseAmount.signum() > 0) {
                gstAmount = r2(baseAmount.multiply(nz(gstRate)).movePointLeft(2));
                tdsAmount = debit() ? r2(baseAmount.multiply(nz(tdsRate)).movePointLeft(2)) : BigDecimal.ZERO;
                amount = baseAmount.add(gstAmount).subtract(tdsAmount);
            } else { baseAmount = null; gstAmount = BigDecimal.ZERO; tdsAmount = BigDecimal.ZERO; gstRate = null; tdsRate = null; tdsSection = null; }
            rule(amount != null && amount.signum() > 0, "amount-required", "Enter an amount above zero");
            rule(amount.compareTo(MAX) <= 0, "amount-too-large", "That amount is too large");
            amount = r2(amount);
        }
        /** The journal lines: out = Dr expense (+ input GST) / Cr bank (+ TDS payable); in = Dr bank / Cr income (+ GST payable). */
        public List<Journal.Line> lines() {
            Money net = new Money(amount), gst = new Money(nz(gstAmount)), tds = new Money(nz(tdsAmount));
            Money gross = net.plus(tds), base = gross.minus(gst);
            String expense = "Cultural".equals(module) ? "5100" : "5000";
            List<Journal.Line> l = new ArrayList<>();
            if (payout()) {
                Money gross2 = new Money(baseAmount);
                l.add(Journal.Line.debit("1000", null, net, "Payout received")); l.add(Journal.Line.debit("5000", null, gross2.minus(net), "Payment provider fees"));
                l.add(Journal.Line.credit("1200", null, gross2, "Gateway clearing"));
                return l;
            }
            if (debit()) {
                l.add(Journal.Line.debit(expense, unitId, base, description)); l.add(Journal.Line.debit("1300", unitId, gst, "Input GST"));
                l.add(Journal.Line.credit("1000", unitId, net, "Paid" + (mode == null ? "" : " (" + mode + ")"))); l.add(Journal.Line.credit("2150", unitId, tds, "TDS " + (tdsSection == null ? "" : tdsSection)));
            } else {
                l.add(Journal.Line.debit("1000", unitId, net, "Received" + (mode == null ? "" : " (" + mode + ")")));
                l.add(Journal.Line.credit("4900", unitId, base, description)); l.add(Journal.Line.credit("2100", unitId, gst, "GST"));
            }
            return l;
        }
        /** The reversal of this entry: the opposite movement, same amounts, pointing at it. */
        public Entry reversal(LocalDate on, String why) {
            Entry r = new Entry();
            r.date = on; r.account = account; r.description = "Reversal of " + shortId + ": " + description; r.category = category; r.subCategory = subCategory; r.type = debit() ? "Credit" : "Debit";
            r.amount = amount; r.vendor = vendor; r.taskRef = taskRef; r.module = module; r.sourceType = "reversal"; r.sourceId = id; r.mode = mode; r.fund = fund; r.unitId = unitId;
            r.reversalOf = shortId; r.reason = why; r.reconStatus = "Not applicable";
            return r;
        }
        /** The reversal's journal: the original lines, sides swapped (an income reversal must not become an expense). */
        public List<Journal.Line> swapped() {
            return lines().stream().map((x) -> new Journal.Line(x.accountCode(), x.accountId(), x.unitId(), x.credit(), x.debit(), "Reversed: " + x.narration())).toList();
        }
    }

    public static final class Release {
        public UUID id; public String shortId; public UUID ticketId; public String ticketShortId; public UUID expenseId; public String kind = "Release"; public BigDecimal amount; public String vendor;
        public String note; public String status = "Waiting approval"; public String cancelReason; public UUID cancelledById; public Instant cancelledAt; public UUID raisedById; public String raisedBy;
        public Plan plan; public Instant paidAt; public UUID paidEntryId; public Instant createdAt; public long version;
        public void mirror() { if (plan != null && "Waiting approval".equals(status)) status = plan.rejected() ? "Rejected" : plan.approved() ? "Approved" : "Waiting approval"; }
    }
    public static final class PayRequest {
        public UUID id; public String shortId; public String description; public BigDecimal amount; public String vendor; public String status = "Waiting"; public UUID requestedById;
        public String requestedBy; public UUID decidedById; public String decidedBy; public Instant decidedAt; public String decisionNote; public String payload; public UUID entryId;
        public Instant createdAt; public long version;
    }
    public record BankLine(UUID id, String shortId, LocalDate date, String account, String narration, String head, BigDecimal debit, BigDecimal credit, BigDecimal balance, String party,
                           String remarks, UUID matchedEntryId, long version) {
        public boolean out() { return debit != null && debit.signum() > 0; }
        public BigDecimal value() { return out() ? debit : credit; }
    }

    static BigDecimal nz(BigDecimal b) { return b == null ? BigDecimal.ZERO : b; }
    public static BigDecimal r2(BigDecimal b) { return b.setScale(2, RoundingMode.HALF_UP); }
    static void rule(boolean ok, String code, String message) { if (!ok) throw new DomainException.RuleViolated(code, message); }
}
