package com.communityos.api.amenity.domain;

import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * A booking and its money: the price it was booked at, how it was paid, and what cancelling, refunding and settling the deposit do to it.
 * Each action checks the state it starts from and returns what moved, so the service can post the ledger and the unit's credit.
 * (The legacy amenityServer actions, on the server.)
 */
public final class Booking {
    public static final List<String> ONLINE = List.of("UPI", "Card", "Net banking");
    public static final List<String> OFFICE = List.of("Cash", "Cheque");
    public static final List<String> PAYOUT = List.of("UPI", "Card", "Net banking", "Cheque", "Cash", "Bank transfer");
    public static final Set<String> NEEDS_REF = Set.of("UPI", "Net banking", "Bank transfer", "Cheque");

    public static final class State {
        public UUID id; public String shortId; public UUID amenityTypeId; public String amenityName; public UnitId unit; public String unitNo; public LocalDate date; public String slot;
        public Instant startAt; public String status; public String paymentMode; public String paymentStatus; public String bookedFor = "Unit"; public String association;
        public BigDecimal rate, baseAmount, gstRate, gstAmount, feeTotal, depositAmount, totalPayable, extrasTotal; public String rateUnit, gstMode;
        public List<Pricing.Line> extras = List.of(); public List<AmenityType.Tier> policy = List.of();
        public boolean chargeWaived; public BigDecimal waivedAmount; public String waiveReason;
        public BigDecimal creditApplied = BigDecimal.ZERO, paidAmount = BigDecimal.ZERO; public Instant paidAt; public String paymentRef; public UUID paymentId;
        public String depositStatus = "None"; public String refundStatus = "None"; public BigDecimal refundAmount = BigDecimal.ZERO;
        public String cancelReason; public Instant cancelledAt; public UUID cancelledBy; public String cancelledByName; public Instant completedAt;
        public BigDecimal refundPct, refundFeeAmount, depositReturned, retainedAmount; public String refundTo; public Instant refundPaidAt; public UUID refundPaidBy;
        public String refundPayoutMode, refundRef;
        public BigDecimal depositDeduction; public String depositDeductionReason; public Instant depositSettledAt; public String depositRefundMode, depositRefundStatus;
        public Instant depositRefundPaidAt; public String depositRefundRef; public BigDecimal feeCorrectedFrom; public String feeCorrectionReason;
        public UUID bookedBy; public String bookedByName; public Instant createdAt, updatedAt; public long version;
    }
    private final State s;
    public Booking(State s) { this.s = s; }
    public State state() { return s; }
    public UUID id() { return s.id; } public String shortId() { return s.shortId; } public long version() { return s.version; } public UnitId unit() { return s.unit; }
    public String status() { return s.status; } public boolean live() { return "Confirmed".equals(s.status) || "Pending payment".equals(s.status); }
    public BigDecimal total() { return nz(s.totalPayable); }
    /** What the unit still owes on it (the total less what was paid or covered by credit). */
    public BigDecimal owed() { return "Pending".equals(s.paymentStatus) ? nz(s.totalPayable).subtract(nz(s.creditApplied)).max(BigDecimal.ZERO) : BigDecimal.ZERO; }

    // ---- paying -------------------------------------------------------------------------------------------------------------------------------
    /** The office received what was owed. */
    public BigDecimal received(String mode, String ref, Instant now) {
        if (!"Pending".equals(s.paymentStatus)) throw rule("not-pending", "No payment is pending on this booking");
        if (mode == null || !(PAYOUT.contains(mode))) throw rule("bad-mode", "Choose how it was paid");
        if (NEEDS_REF.contains(mode) && blank(ref)) throw rule("ref-required", needRef(mode));
        BigDecimal owed = owed();
        s.status = "Confirmed"; s.paymentStatus = "Paid"; s.paidAmount = nz(s.totalPayable); s.paidAt = now; s.paymentMode = mode; s.paymentRef = blank(ref) ? null : ref.strip();
        s.depositStatus = nz(s.depositAmount).signum() > 0 ? "Held" : "None";
        return owed;
    }

    // ---- cancelling -----------------------------------------------------------------------------------------------------------------------------
    /** What a cancellation moved: the fee refunded (and its GST share), the deposit returned, where it went, and the receivable written back. */
    public record Cancelled(BigDecimal refundFee, BigDecimal refundFeeGst, BigDecimal deposit, boolean toCredit, BigDecimal creditRestored, boolean unpaid) {}
    public Cancelled cancel(boolean staff, boolean waive, BigDecimal refundOverride, Boolean wantCredit, boolean creditByDefault, String reason, UUID me, String myName, Instant now) {
        if (!live()) throw rule("finished", "This booking is already finished");
        if (!staff && !now.isBefore(s.startAt)) throw rule("started", "This booking has already started");
        if (staff && blank(reason)) throw rule("reason-required", "Give a reason for cancelling");
        s.status = "Cancelled"; s.cancelledAt = now; s.cancelledBy = me; s.cancelledByName = myName;
        s.cancelReason = blank(reason) ? (staff && waive ? "Cancelled by the community" : null) : reason.strip();
        boolean paid = "Paid".equals(s.paymentStatus);
        if (!paid) {
            // nothing received in money: the charge is written back; any unit credit used is given straight back
            BigDecimal credit = nz(s.creditApplied);
            s.refundPct = BigDecimal.valueOf(100); s.refundFeeAmount = BigDecimal.ZERO; s.depositReturned = BigDecimal.ZERO; s.retainedAmount = BigDecimal.ZERO;
            s.refundAmount = credit; s.refundTo = credit.signum() > 0 ? "Unit account" : null; s.refundStatus = credit.signum() > 0 ? "Credited to unit account" : "None";
            s.paymentStatus = "Not required".equals(s.paymentStatus) ? "Not required" : "Cancelled"; s.depositStatus = "None";
            return new Cancelled(BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO, true, credit, true);
        }
        Pricing.CancelQuote q = Pricing.cancellation(s.policy.isEmpty() ? AmenityType.DEFAULT_TIERS : s.policy, s.startAt, now, nz(s.feeTotal), nz(s.depositAmount), staff && waive);
        BigDecimal refundFee = q.refundFee();
        if (staff && refundOverride != null) refundFee = Pricing.r2(refundOverride.max(BigDecimal.ZERO).min(nz(s.feeTotal)));
        BigDecimal gstShare = nz(s.feeTotal).signum() == 0 ? BigDecimal.ZERO : refundFee.multiply(nz(s.gstAmount)).divide(nz(s.feeTotal), 2, RoundingMode.HALF_UP);
        BigDecimal refund = refundFee.add(q.refundDeposit());
        boolean viaCredit = "Unit credit".equals(s.paymentMode) || nz(s.creditApplied).signum() > 0;
        boolean toCredit = s.unit != null && ((wantCredit != null ? wantCredit : creditByDefault) || viaCredit);
        s.refundPct = staff && waive ? BigDecimal.valueOf(100) : q.pct(); s.refundFeeAmount = refundFee; s.depositReturned = q.refundDeposit();
        s.retainedAmount = nz(s.feeTotal).subtract(refundFee); s.refundAmount = refund;
        s.refundTo = refund.signum() <= 0 ? null : toCredit ? "Unit account" : "Original payment mode" + (blank(s.paymentMode) ? "" : " (" + s.paymentMode + ")");
        s.refundStatus = refund.signum() <= 0 ? "None" : toCredit ? "Credited to unit account" : "Refund due";
        s.paymentStatus = refund.signum() <= 0 ? "Paid" : toCredit ? (refund.compareTo(nz(s.totalPayable)) >= 0 ? "Refunded" : "Partially refunded") : "Refund due";
        s.depositStatus = "Held".equals(s.depositStatus) ? "Returned" : "Awaiting payment".equals(s.depositStatus) ? "None" : s.depositStatus;
        return new Cancelled(refundFee, gstShare, q.refundDeposit(), toCredit, BigDecimal.ZERO, false);
    }

    /** The office paid a refund out (by hand, or started through the provider for an online payment). Returns the amount. */
    public BigDecimal refundPaid(String mode, String ref, boolean initiate, UUID me, Instant now) {
        if (!"Refund due".equals(s.refundStatus)) throw rule("no-refund", "No refund is due on this booking");
        String pm = initiate ? s.paymentMode : blank(mode) ? (blank(s.paymentMode) ? "Cash" : s.paymentMode) : mode;
        if (initiate && !ONLINE.contains(pm)) throw rule("not-online", "A " + (blank(pm) ? "cash" : pm) + " payment cannot be sent back automatically - pay it out and record it instead");
        if (!PAYOUT.contains(pm)) throw rule("bad-mode", "Choose how the refund was paid");
        if (!initiate && NEEDS_REF.contains(pm) && blank(ref)) throw rule("ref-required", needRef(pm));
        boolean partial = nz(s.refundAmount).compareTo(nz(s.totalPayable)) < 0;
        s.refundStatus = "Refunded"; s.paymentStatus = partial ? "Partially refunded" : "Refunded"; s.refundPaidAt = now; s.refundPaidBy = me; s.refundPayoutMode = pm;
        s.refundRef = initiate ? "GW" + Long.toString(now.toEpochMilli(), 36).toUpperCase() : ref.strip();
        return nz(s.refundAmount);
    }
    // ---- a refund through the payment provider: asked for, then processed (or refused) when the provider says so --------------------------------
    /** What the provider is asked to send back for this part ("fee" or "deposit"), checking that it is due and was paid online. */
    public BigDecimal providerRefundDue(String part) {
        boolean fee = "fee".equals(part);
        if (fee ? !"Refund due".equals(s.refundStatus) : !"Due".equals(s.depositRefundStatus)) throw rule(fee ? "no-refund" : "no-deposit-refund", fee ? "No refund is due on this booking" : "No deposit refund is due");
        if (!ONLINE.contains(s.paymentMode) || s.paymentId == null) throw rule("not-online", "A " + (blank(s.paymentMode) ? "cash" : s.paymentMode) + " payment cannot be sent back automatically - pay it out and record it instead");
        BigDecimal amount = nz(fee ? s.refundAmount : s.depositReturned);
        if (amount.signum() <= 0) throw rule("nothing-to-refund", "There is nothing to send back");
        return amount;
    }
    public void providerRefundAsked(String part, String refundShortId) {
        if ("fee".equals(part)) { if ("Refund due".equals(s.refundStatus)) { s.refundStatus = "Refund initiated"; s.refundPayoutMode = s.paymentMode; s.refundRef = refundShortId; } }
        else if ("Due".equals(s.depositRefundStatus)) { s.depositRefundStatus = "Initiated"; s.depositRefundMode = s.paymentMode; s.depositRefundRef = refundShortId; }
    }
    /** The provider sent it back: the money is out. Returns the amount (for the ledger), or null when this part was settled some other way meanwhile. */
    public BigDecimal providerRefundProcessed(String part, String providerRef, Instant now) {
        if ("fee".equals(part)) {
            if (!"Refund initiated".equals(s.refundStatus) && !"Refund due".equals(s.refundStatus)) return null;
            boolean partial = nz(s.refundAmount).compareTo(nz(s.totalPayable)) < 0;
            s.refundStatus = "Refunded"; s.paymentStatus = partial ? "Partially refunded" : "Refunded"; s.refundPaidAt = now; s.refundPayoutMode = s.paymentMode; s.refundRef = providerRef;
            return nz(s.refundAmount);
        }
        if (!"Initiated".equals(s.depositRefundStatus) && !"Due".equals(s.depositRefundStatus)) return null;
        s.depositRefundStatus = "Paid"; s.depositRefundPaidAt = now; s.depositRefundMode = s.paymentMode; s.depositRefundRef = providerRef;
        return nz(s.depositReturned);
    }
    /** The provider could not send it back: it is due again (to retry, pay out by hand, or credit to the unit). */
    public void providerRefundFailed(String part) {
        if ("fee".equals(part)) { if ("Refund initiated".equals(s.refundStatus)) { s.refundStatus = "Refund due"; s.refundRef = null; } }
        else if ("Initiated".equals(s.depositRefundStatus)) { s.depositRefundStatus = "Due"; s.depositRefundRef = null; }
    }
    public BigDecimal refundToCredit(UUID me, Instant now) {
        if (!"Refund due".equals(s.refundStatus)) throw rule("no-refund", "No refund is due on this booking");
        if (s.unit == null) throw rule("no-unit", "An association booking has no unit account");
        boolean partial = nz(s.refundAmount).compareTo(nz(s.totalPayable)) < 0;
        s.refundStatus = "Credited to unit account"; s.refundTo = "Unit account"; s.paymentStatus = partial ? "Partially refunded" : "Refunded";
        s.refundPaidAt = now; s.refundPaidBy = me; s.refundPayoutMode = "Unit credit";
        return nz(s.refundAmount);
    }

    public void complete(Instant now) {
        if (!"Confirmed".equals(s.status)) throw rule("not-confirmed", "Only a confirmed booking can be completed");
        s.status = "Completed"; s.completedAt = now;
    }

    // ---- the security deposit -------------------------------------------------------------------------------------------------------------------
    public record DepositSettled(BigDecimal forfeited, BigDecimal back, boolean toCredit) {}
    public DepositSettled settleDeposit(BigDecimal deduction, String reason, String payoutMode, boolean creditByDefault, Instant now) {
        if (!"Held".equals(s.depositStatus)) throw rule("no-deposit", "No security deposit is held for this booking");
        if ("Cancelled".equals(s.status)) throw rule("cancelled", "A cancelled booking already returned its deposit");
        BigDecimal dep = nz(s.depositAmount);
        BigDecimal ded = Pricing.r2(deduction == null ? BigDecimal.ZERO : deduction.max(BigDecimal.ZERO).min(dep));
        String why = reason == null ? "" : reason.replaceAll("<[^>]*>", " ").replace("&nbsp;", " ").strip();
        if (ded.signum() > 0 && why.isEmpty()) throw rule("reason-required", "Give a reason for the deduction");
        BigDecimal back = dep.subtract(ded);
        boolean viaCredit = "Unit credit".equals(s.paymentMode) || nz(s.creditApplied).signum() > 0;
        String pm = !blank(payoutMode) ? payoutMode : s.unit != null && (creditByDefault || viaCredit) ? "Unit credit" : blank(s.paymentMode) ? "Cash" : s.paymentMode;
        if (!"Unit credit".equals(pm) && !PAYOUT.contains(pm)) throw rule("bad-mode", "Choose how the deposit is returned");
        if ("Unit credit".equals(pm) && s.unit == null) throw rule("no-unit", "An association booking has no unit account");
        boolean toCredit = "Unit credit".equals(pm);
        if ("Confirmed".equals(s.status)) { s.status = "Completed"; s.completedAt = now; }
        s.depositReturned = back; s.depositDeduction = ded; s.depositDeductionReason = why.isEmpty() ? null : why; s.depositSettledAt = now;
        s.depositRefundMode = back.signum() > 0 ? pm : null;
        s.depositStatus = ded.signum() == 0 ? "Released" : ded.compareTo(dep) >= 0 ? "Forfeited" : "Partly forfeited";
        s.depositRefundStatus = back.signum() > 0 ? (toCredit ? "Credited to unit account" : "Due") : "None";
        return new DepositSettled(ded, back, toCredit);
    }
    public BigDecimal depositPaid(String mode, String ref, boolean initiate, Instant now) {
        if (!"Due".equals(s.depositRefundStatus)) throw rule("no-deposit-refund", "No deposit refund is due");
        String pm = initiate ? s.paymentMode : blank(mode) ? (blank(s.depositRefundMode) ? "Cash" : s.depositRefundMode) : mode;
        if (initiate && !ONLINE.contains(pm)) throw rule("not-online", "A " + (blank(pm) ? "cash" : pm) + " payment cannot be sent back automatically - pay it out and record it instead");
        if (!PAYOUT.contains(pm)) throw rule("bad-mode", "Choose how the deposit was paid back");
        if (!initiate && NEEDS_REF.contains(pm) && blank(ref)) throw rule("ref-required", needRef(pm));
        s.depositRefundStatus = "Paid"; s.depositRefundPaidAt = now; s.depositRefundMode = pm;
        s.depositRefundRef = initiate ? "GW" + Long.toString(now.toEpochMilli(), 36).toUpperCase() : ref.strip();
        return nz(s.depositReturned);
    }

    // ---- correcting the fee -----------------------------------------------------------------------------------------------------------------------
    /** Only while nothing is paid: the new fee includes GST at the booking's rate. Returns the old total (the charge to write back). */
    public BigDecimal adjustFee(BigDecimal newFee, String reason, Instant now) {
        if (!live()) throw rule("not-live", "Only a live booking can be corrected");
        if ("Paid".equals(s.paymentStatus) || nz(s.creditApplied).signum() > 0)
            throw rule("paid", "This booking is already paid (or part-paid from credit). Cancel it with the right refund, then book it again at the correct price.");
        if (newFee == null || newFee.signum() < 0) throw rule("bad-fee", "Enter the correct fee");
        if (blank(reason)) throw rule("reason-required", "Give a reason for the correction");
        BigDecimal oldTotal = nz(s.totalPayable);
        BigDecimal fee = Pricing.r2(newFee), rate = nz(s.gstRate);
        BigDecimal gst = rate.signum() > 0 ? fee.subtract(fee.multiply(BigDecimal.valueOf(100)).divide(BigDecimal.valueOf(100).add(rate), 2, RoundingMode.HALF_UP)) : BigDecimal.ZERO;
        s.feeCorrectedFrom = nz(s.feeTotal); s.feeCorrectionReason = reason.strip();
        s.baseAmount = fee.subtract(gst); s.gstAmount = gst; s.feeTotal = fee; s.totalPayable = fee.add(nz(s.depositAmount));
        if (s.totalPayable.signum() <= 0) { s.paymentStatus = "Not required"; s.status = "Confirmed"; }
        return oldTotal;
    }

    static BigDecimal nz(BigDecimal b) { return b == null ? BigDecimal.ZERO : b; }
    static boolean blank(String s) { return s == null || s.isBlank(); }
    static String needRef(String pm) { return "Enter the " + ("Cheque".equals(pm) ? "cheque number" : "transaction / UTR reference"); }
    static DomainException.RuleViolated rule(String code, String m) { return new DomainException.RuleViolated(code, m); }
}
