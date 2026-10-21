package com.communityos.api.amenity.application;

import com.communityos.api.amenity.domain.Booking;
import com.communityos.api.billing.application.BillingDesk;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.billing.domain.Journal.Line;
import com.communityos.api.shared.domain.Money;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;

/**
 * The double-entry side of bookings (accounts: 1100 Members receivable, 4200 Amenity income, 2100 Tax payable, 2200 Security deposits held,
 * 2000 Advances from members = unit credit, 2400 Refunds payable, 1000 Bank, 1200 Gateway clearing). A booking with a price is a receivable
 * from the moment it is made; payments (office, credit, prepayment) clear it through billing.
 */
public final class AmenityLedger {
    private final BillingDesk desk; private final ZoneId zone;
    public AmenityLedger(BillingDesk desk, ZoneId zone) { this.desk = desk; this.zone = zone; }

    static Money m(BigDecimal b) { return new Money(b == null ? BigDecimal.ZERO : b); }
    private UUID unit(Booking b) { return b.unit() == null ? null : b.unit().value(); }
    private void post(Instant at, String memo, Booking b, List<Line> lines) { desk.post(new Journal.Entry(at.atZone(zone).toLocalDate(), memo + " " + b.shortId(), "booking", b.id(), lines)); }

    /** Booked with a price: the unit owes the fee and the deposit. */
    public void charge(Booking b, Instant at) {
        Booking.State s = b.state();
        if (b.total().signum() <= 0) return;
        post(at, "Booking", b, List.of(Line.debit("1100", unit(b), m(s.totalPayable), "Booking receivable"), Line.credit("4200", unit(b), m(s.baseAmount), "Amenity income"),
            Line.credit("2100", unit(b), m(s.gstAmount), "GST"), Line.credit("2200", unit(b), m(s.depositAmount), "Security deposit held")));
    }
    /** The charge written back (cancelled before it was paid, or a fee correction): credit used comes back as credit. */
    public void uncharge(Booking b, BigDecimal total, BigDecimal base, BigDecimal gst, BigDecimal deposit, BigDecimal creditRestored, Instant at, String why) {
        if (total.signum() <= 0) return;
        post(at, why, b, List.of(Line.debit("4200", unit(b), m(base), "Amenity income reversed"), Line.debit("2100", unit(b), m(gst), "GST reversed"),
            Line.debit("2200", unit(b), m(deposit), "Deposit no longer held"), Line.credit("1100", unit(b), m(total.subtract(creditRestored)), "Receivable cleared"),
            Line.credit("2000", unit(b), m(creditRestored), "Unit credit given back")));
    }
    /** A paid booking cancelled: the refunded part of the fee (and its GST) and the deposit go to the unit's credit or become payable. */
    public void refund(Booking b, BigDecimal refundFee, BigDecimal refundGst, BigDecimal deposit, boolean toCredit, Instant at) {
        BigDecimal total = refundFee.add(deposit);
        if (total.signum() <= 0) return;
        post(at, "Booking cancelled", b, List.of(Line.debit("4200", unit(b), m(refundFee.subtract(refundGst)), "Fee refunded"), Line.debit("2100", unit(b), m(refundGst), "GST refunded"),
            Line.debit("2200", unit(b), m(deposit), "Deposit returned"), Line.credit(toCredit ? "2000" : "2400", unit(b), m(total), toCredit ? "Refund to unit credit" : "Refund payable")));
    }
    /** A refund payable paid out (bank / cash), or sent back through the provider (gateway clearing). */
    public void payout(Booking b, BigDecimal amount, boolean viaGateway, String what, Instant at) {
        if (amount.signum() <= 0) return;
        post(at, what, b, List.of(Line.debit("2400", unit(b), m(amount), "Refund paid"), Line.credit(viaGateway ? "1200" : "1000", unit(b), m(amount), viaGateway ? "Refunded via the provider" : "Paid out")));
    }
    /** A refund payable moved to the unit's credit instead. */
    public void payableToCredit(Booking b, BigDecimal amount, Instant at) {
        if (amount.signum() <= 0) return;
        post(at, "Refund to unit credit", b, List.of(Line.debit("2400", unit(b), m(amount), "Refund payable cleared"), Line.credit("2000", unit(b), m(amount), "Unit credit")));
    }
    /** The deposit settled: what is kept becomes income, the rest goes back (credit or payable). */
    public void depositSettled(Booking b, BigDecimal forfeited, BigDecimal back, boolean toCredit, Instant at) {
        post(at, "Deposit settled", b, List.of(Line.debit("2200", unit(b), m(forfeited.add(back)), "Deposit released"), Line.credit("4200", unit(b), m(forfeited), "Deposit kept (damage / rules)"),
            Line.credit(toCredit ? "2000" : "2400", unit(b), m(back), toCredit ? "Deposit to unit credit" : "Deposit to pay back")));
    }
}
