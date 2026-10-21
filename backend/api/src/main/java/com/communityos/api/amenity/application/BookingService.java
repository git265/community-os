package com.communityos.api.amenity.application;

import com.communityos.api.amenity.application.port.AmenityCatalog;
import com.communityos.api.amenity.application.port.BookingRepository;
import com.communityos.api.amenity.domain.AmenityType;
import com.communityos.api.amenity.domain.Booking;
import com.communityos.api.amenity.domain.BookingEvents;
import com.communityos.api.amenity.domain.Pricing;
import com.communityos.api.billing.application.BillingDesk;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;

/**
 * Booking an amenity and everything after (the legacy amenityPreWrite, on the server):
 *   book      the amenity row is locked, so two people cannot take the last place; capacity per date / slot; the booking window and the
 *             per-unit limits (unless the amenity's team overrides); overdue dues hold a resident back; the price, GST, deposit and add-on items
 *             are worked out here from the catalog; payment is free, unit credit, an online prepayment the booking claims, or at the office
 *   cancel    by the resident before it starts, or by the team (with a reason, optionally waived or with another refund); refunds follow
 *             the cancellation tiers the booking was made under, the deposit comes back in full
 *   then      receive payment, pay a refund out / to credit, complete, settle the deposit (with deductions), pay the deposit back, correct a fee
 * Every money step posts the ledger in the same transaction.
 */
public final class BookingService {
    public record Book(UUID amenityTypeId, UnitId unitId, LocalDate date, String slot, String paymentMode, UUID prepaymentId, boolean useCredit, String bookedFor,
                       String association, boolean freeOfCharge, String waiveReason, Map<UUID, Integer> extras) {}
    public record Cancel(String reason, Boolean refundToCredit, boolean waive, BigDecimal refundOverride) {}

    private final BookingRepository bookings; private final AmenityCatalog catalog; private final BillingDesk desk; private final AmenityLedger ledger;
    private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    private final BookingPolicy policy = new BookingPolicy();

    public BookingService(BookingRepository bookings, AmenityCatalog catalog, BillingDesk desk, AmenityLedger ledger, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.bookings = bookings; this.catalog = catalog; this.desk = desk; this.ledger = ledger; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    public List<Booking> list(Caller c, BookingRepository.Filter f) { return bookings.find(policy.readScope(c), f); }
    public Booking get(Caller c, UUID id) { return bookings.get(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new); }
    /** How full each date / slot is - for anyone who may book. */
    public List<BookingRepository.Taken> availability(Caller c, UUID amenityTypeId, LocalDate from, LocalDate to) {
        if (c.category() == Caller.Category.Vendor) throw new AccessDenied("Vendors do not book amenities");
        if (from == null || to == null || to.isBefore(from) || from.plusDays(120).isBefore(to)) throw new DomainException.RuleViolated("bad-range", "Ask for up to 120 days");
        return bookings.taken(amenityTypeId, from, to);
    }

    // ---- book -------------------------------------------------------------------------------------------------------------------------------------
    public Booking book(Caller c, Book cmd) {
        if (c.membership() == null || c.category() == Caller.Category.Vendor || c.category() == Caller.Category.System) throw new AccessDenied("Sign in as a member to book");
        boolean staff = BookingPolicy.staff(c);
        boolean association = "Association".equals(cmd.bookedFor());
        if (association && !staff) throw new AccessDenied("Only the amenities team can reserve for an association");
        if (!staff && cmd.freeOfCharge()) throw new AccessDenied("Only the amenities team can waive the charges");
        if (cmd.date() == null) throw new DomainException.RuleViolated("date-required", "Choose a date");
        return tx.inTx(() -> {
            Instant now = clock.instant(); LocalDate today = LocalDate.now(clock);
            AmenityType a = catalog.lockType(cmd.amenityTypeId()).orElseThrow(() -> new DomainException.RuleViolated("unknown-amenity", "There is no such amenity"));
            if (!a.active()) throw new DomainException.RuleViolated("closed", "This amenity is not open for booking right now");
            if (a.walkIn() && !staff) throw new DomainException.RuleViolated("walk-in", a.name() + " needs no reservation. Just walk in.");
            String slot = Pricing.checkSlot(a, cmd.slot());
            // whose booking
            AmenityCatalog.UnitInfo unit = null;
            if (!association) {
                UnitId u = cmd.unitId() != null ? cmd.unitId() : c.isResident() && c.units().size() == 1 ? c.units().iterator().next() : null;
                if (u == null) throw new DomainException.RuleViolated("unit-required", "Say which unit the booking is for");
                if (!staff && !c.units().contains(u)) throw new AccessDenied("You can only book for your own unit");
                unit = catalog.unit(u).orElseThrow(AccessDenied.NotVisible::new);
                if (c.isBlockLimited() && (unit.block() == null || !c.blocks().contains(unit.block()))) throw new AccessDenied.NotVisible();
            } else if (cmd.association() == null || cmd.association().isBlank()) throw new DomainException.RuleViolated("association-required", "Name the association");
            // room left
            List<Booking> sameDay = bookings.liveOn(a.id(), cmd.date());
            long taken = sameDay.stream().filter((b) -> a.fullDay() || overlaps(b.state().slot, slot)).count();
            if (taken >= a.capacity()) throw new DomainException.RuleViolated("taken", "That booking is no longer available.");
            Instant start = Pricing.startAt(cmd.date(), slot, a, clock.getZone());
            if (!Pricing.mayOverride(a, staff, c.isSuperAdmin(), c.roleCodes())) {
                String w = Pricing.windowError(a, start, now);
                if (w != null) throw new DomainException.RuleViolated("window", w);
                if (unit != null) {
                    String lim = Pricing.limitsError(a, cmd.date(), unit.unitType(), bookings.heldBy(a.id(), unit.id()), today);
                    if (lim != null) throw new DomainException.RuleViolated("limit", lim);
                }
            } else if (cmd.date().isBefore(today)) throw new DomainException.RuleViolated("past", "That date has already passed.");
            if (!staff && unit != null) {
                String hold = catalog.defaulterHold(unit.id(), today);
                if (hold != null) throw new DomainException.RuleViolated("defaulter", hold);
            }
            // the price
            Map<UUID, Integer> held = new HashMap<>();
            for (Booking b : sameDay) if (a.fullDay() || "Full day".equals(slot) || overlaps(b.state().slot, slot)) for (Pricing.Line l : b.state().extras) held.merge(l.itemId(), l.qty(), Integer::sum);
            Pricing.Extras ex = Pricing.price(cmd.extras(), catalog.items(), a.id(), held);
            AmenityCatalog.Settings st = catalog.settings();
            Pricing.Quote q = Pricing.quote(a, cmd.date(), st.defaultGstRate(), ex.total());
            boolean waived = staff && cmd.freeOfCharge() && q.total().signum() > 0;
            if (waived && (cmd.waiveReason() == null || cmd.waiveReason().isBlank())) throw new DomainException.RuleViolated("reason-required", "Give a reason for waiving the charges");
            if (association && q.total().signum() > 0 && !waived) throw new DomainException.RuleViolated("association-charged", "An association booking is free of charge: tick \"free of charge\" and give the reason");
            BigDecimal waivedAmount = waived ? q.total() : null;
            if (waived) q = q.waived();

            Booking.State s = new Booking.State();
            s.id = UUID.randomUUID(); s.amenityTypeId = a.id(); s.amenityName = a.name(); s.unit = unit == null ? null : unit.id(); s.unitNo = unit == null ? null : unit.unitNo();
            s.date = cmd.date(); s.slot = slot; s.startAt = start; s.bookedFor = association ? "Association" : "Unit"; s.association = association ? cmd.association().strip() : null;
            s.rate = q.rate(); s.rateUnit = q.rateUnit(); s.baseAmount = q.base(); s.gstRate = q.gstRate(); s.gstAmount = q.gst(); s.gstMode = q.gstMode(); s.feeTotal = q.fee();
            s.depositAmount = q.deposit(); s.totalPayable = q.total(); s.extras = ex.lines(); s.extrasTotal = ex.total(); s.policy = a.tiers();
            s.chargeWaived = waived; s.waivedAmount = waivedAmount; s.waiveReason = waived ? cmd.waiveReason().strip() : null;
            s.bookedBy = c.membership().value(); s.bookedByName = c.displayName();
            String mode = cmd.paymentMode() == null || cmd.paymentMode().isBlank() ? Booking.ONLINE.get(0) : cmd.paymentMode();
            BigDecimal total = q.total();
            BigDecimal credit = BigDecimal.ZERO;
            if (total.signum() > 0 && cmd.useCredit() && unit != null) credit = desk.credit(unit.id()).amount().max(BigDecimal.ZERO).min(total);
            if (credit.compareTo(new BigDecimal("0.01")) < 0) credit = BigDecimal.ZERO;
            BigDecimal rest = total.subtract(credit);
            String how;   // what pays the rest
            if (total.signum() <= 0) { s.paymentStatus = "Not required"; s.status = "Confirmed"; s.paymentMode = null; how = "none"; }
            else if (rest.signum() <= 0) { s.paymentStatus = "Paid"; s.status = "Confirmed"; s.paymentMode = "Unit credit"; how = "credit"; }
            else if (Booking.ONLINE.contains(mode)) {
                if (cmd.prepaymentId() == null && !staff) throw new DomainException.RuleViolated("pay-first", "Pay online first, then confirm the booking with that payment");
                s.paymentStatus = "Paid"; s.status = "Confirmed"; s.paymentMode = mode; how = cmd.prepaymentId() != null ? "prepaid" : "office";
            } else if (Booking.OFFICE.contains(mode) || "Bank transfer".equals(mode)) {
                s.paymentMode = mode;
                if (staff) { s.paymentStatus = "Paid"; s.status = "Confirmed"; how = "office"; }
                else { s.paymentStatus = "Pending"; s.status = "Pending payment"; how = "later"; }
            } else throw new DomainException.RuleViolated("bad-mode", "Choose a payment option");
            if (unit == null && !"none".equals(how)) throw new DomainException.RuleViolated("no-unit", "Only a unit pays for a booking");
            s.creditApplied = credit;
            s.depositStatus = s.depositAmount.signum() <= 0 ? "None" : "Paid".equals(s.paymentStatus) ? "Held" : "Awaiting payment";
            Booking b = new Booking(s);
            // the money first (what can still refuse: a prepayment that is not good enough), then the booking and its charge - one transaction
            String what = a.name() + " " + s.date + " " + slot;
            if (credit.signum() > 0) desk.useCredit(c, unit.id(), new Money(credit), "booking", s.id, what);
            switch (how) {
                case "prepaid" -> { desk.usePrepayment(c, unit.id(), cmd.prepaymentId(), "booking", new Money(rest), "booking", s.id, what); s.paymentId = cmd.prepaymentId(); }
                case "office" -> { var r = desk.receive(c, unit.id(), new Money(rest), mode, null, "booking", s.id, new Money(rest)); s.paymentId = r.id().value(); s.paymentRef = r.receiptNo(); }
                default -> { }
            }
            if ("Paid".equals(s.paymentStatus)) { s.paidAmount = total; s.paidAt = now; }
            bookings.insert(b);
            ledger.charge(b, now);
            if (!bookings.save(b)) throw new DomainException.Conflict("Booking " + s.shortId);
            done(c, b, AuditWriter.Action.Create, "created", "Booked " + a.name() + " on " + s.date + " " + slot + (unit == null ? " for " + s.association : " for " + unit.unitNo())
                + " (" + total.toPlainString() + ", " + s.paymentStatus + ")");
            return b;
        });
    }

    // ---- after ------------------------------------------------------------------------------------------------------------------------------------
    public Booking cancel(Caller c, UUID id, long version, Cancel cmd) {
        boolean staff = BookingPolicy.staff(c);
        return change(c, id, version, (b) -> {
            if (!staff && (b.unit() == null || !c.units().contains(b.unit()))) throw new AccessDenied("You can only cancel your own bookings");
            Booking.State s = b.state();
            BigDecimal total = b.total(), base = s.baseAmount, gst = s.gstAmount, dep = s.depositAmount;
            Instant now = clock.instant();
            Booking.Cancelled out = b.cancel(staff, cmd.waive(), cmd.refundOverride(), cmd.refundToCredit(), catalog.settings().refundToCredit(), cmd.reason(),
                c.membership() == null ? null : c.membership().value(), c.displayName(), now);
            if (out.unpaid()) {
                ledger.uncharge(b, total, nz(base), nz(gst), nz(dep), out.creditRestored(), now, "Booking cancelled");
                if (out.creditRestored().signum() > 0) desk.creditUnit(b.unit(), new Money(out.creditRestored()), "booking-refund", b.id(), "Booking " + b.shortId() + " cancelled");
            } else {
                ledger.refund(b, out.refundFee(), out.refundFeeGst(), out.deposit(), out.toCredit(), now);
                if (out.toCredit()) desk.creditUnit(b.unit(), new Money(out.refundFee().add(out.deposit())), "booking-refund", b.id(), "Booking " + b.shortId() + " cancelled");
            }
            return "Cancelled" + (s.refundAmount.signum() > 0 ? " (refund " + s.refundAmount.toPlainString() + " " + s.refundStatus.toLowerCase() + ")" : "");
        });
    }
    public Booking receivePayment(Caller c, UUID id, long version, String mode, String ref) {
        requireStaff(c);
        return change(c, id, version, (b) -> {
            BigDecimal owed = b.received(mode, ref, clock.instant());
            if (owed.signum() > 0) {
                var r = desk.receive(c, b.unit(), new Money(owed), mode, ref, "booking", b.id(), new Money(owed));
                b.state().paymentId = r.id().value(); b.state().paymentRef = ref == null || ref.isBlank() ? r.receiptNo() : ref.strip();
            }
            return "Payment received " + owed.toPlainString() + " (" + mode + ")";
        });
    }
    private com.communityos.api.billing.application.RefundService refunds;
    /** Refunds through the payment provider (wired after both services exist); without it a refund is only paid out and recorded by hand. */
    public BookingService refunds(com.communityos.api.billing.application.RefundService r) {
        this.refunds = r;
        r.register("amenity.booking", this::refundSettled);
        return this;
    }
    /** Ask the payment provider to send a fee refund or a deposit back to the card / UPI / bank it was paid from. Done when the provider says so. */
    public Booking initiateRefund(Caller c, UUID id, long version, String part) {
        requireStaff(c);
        if (refunds == null) throw new DomainException.RuleViolated("no-provider-refunds", "Refunds through the payment provider are not set up - pay it out and record it instead");
        Booking b = bookings.get(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
        if (b.version() != version) throw new DomainException.Conflict("Booking " + b.shortId());
        BigDecimal amount = b.providerRefundDue(part);
        var r = refunds.initiate(c, "amenity.booking", id, part, b.state().paymentId, new Money(amount));   // the provider is asked outside any transaction
        return tx.inTx(() -> {
            Booking cur = bookings.get(id, policy.readScope(c)).orElseThrow();
            cur.providerRefundAsked(part, r.shortId());
            if (!bookings.save(cur)) throw new DomainException.Conflict("Booking " + cur.shortId());
            done(c, cur, AuditWriter.Action.Update, "changed", ("fee".equals(part) ? "Refund " : "Deposit refund ") + amount.toPlainString() + " asked from the payment provider (" + r.shortId() + ") - " + cur.shortId());
            return bookings.get(id, policy.readScope(c)).orElseThrow();
        });
    }
    /** The provider's answer on a refund this service asked for. */
    private void refundSettled(Caller system, com.communityos.api.billing.application.RefundService.Refund r) {
        Booking b = bookings.get(r.ownerId(), com.communityos.api.shared.access.Spec.all()).orElse(null);
        if (b == null) return;
        Instant now = clock.instant();
        String what;
        if ("Processed".equals(r.status())) {
            BigDecimal amount = b.providerRefundProcessed(r.part(), r.providerRefundRef(), now);
            if (amount == null) return;
            ledger.payout(b, amount, true, "fee".equals(r.part()) ? "Refund paid" : "Deposit paid back", now);
            what = ("fee".equals(r.part()) ? "Refund " : "Deposit refund ") + amount.toPlainString() + " sent back by the payment provider (" + r.shortId() + ")";
        } else {
            b.providerRefundFailed(r.part());
            what = ("fee".equals(r.part()) ? "Refund" : "Deposit refund") + " failed at the payment provider: " + r.failureReason() + " - due again";
        }
        if (!bookings.save(b)) throw new DomainException.Conflict("Booking " + b.shortId());
        done(system, b, AuditWriter.Action.Update, "changed", what + " - " + b.shortId());
    }

    public Booking refundPaid(Caller c, UUID id, long version, String mode, String ref, boolean initiate) {
        if (initiate) return initiateRefund(c, id, version, "fee");
        requireStaff(c);
        return change(c, id, version, (b) -> {
            BigDecimal amount = b.refundPaid(mode, ref, initiate, c.membership() == null ? null : c.membership().value(), clock.instant());
            ledger.payout(b, amount, initiate, "Refund paid", clock.instant());
            return "Refund paid " + amount.toPlainString() + " (" + b.state().refundPayoutMode + ")";
        });
    }
    public Booking refundToCredit(Caller c, UUID id, long version) {
        requireStaff(c);
        return change(c, id, version, (b) -> {
            BigDecimal amount = b.refundToCredit(c.membership() == null ? null : c.membership().value(), clock.instant());
            ledger.payableToCredit(b, amount, clock.instant());
            desk.creditUnit(b.unit(), new Money(amount), "booking-refund", b.id(), "Refund of " + b.shortId());
            return "Refund " + amount.toPlainString() + " credited to the unit";
        });
    }
    public Booking complete(Caller c, UUID id, long version) {
        requireStaff(c);
        return change(c, id, version, (b) -> { b.complete(clock.instant()); return "Completed"; });
    }
    public Booking settleDeposit(Caller c, UUID id, long version, BigDecimal deduction, String reason, String payoutMode) {
        requireStaff(c);
        return change(c, id, version, (b) -> {
            Booking.DepositSettled d = b.settleDeposit(deduction, reason, payoutMode, catalog.settings().refundToCredit(), clock.instant());
            ledger.depositSettled(b, d.forfeited(), d.back(), d.toCredit(), clock.instant());
            if (d.toCredit()) desk.creditUnit(b.unit(), new Money(d.back()), "deposit-refund", b.id(), "Deposit of " + b.shortId());
            return "Deposit settled: kept " + d.forfeited().toPlainString() + ", back " + d.back().toPlainString();
        });
    }
    public Booking depositPaid(Caller c, UUID id, long version, String mode, String ref, boolean initiate) {
        if (initiate) return initiateRefund(c, id, version, "deposit");
        requireStaff(c);
        return change(c, id, version, (b) -> {
            BigDecimal amount = b.depositPaid(mode, ref, initiate, clock.instant());
            ledger.payout(b, amount, initiate, "Deposit paid back", clock.instant());
            return "Deposit paid back " + amount.toPlainString();
        });
    }
    public Booking adjustFee(Caller c, UUID id, long version, BigDecimal newFee, String reason) {
        requireStaff(c);
        return change(c, id, version, (b) -> {
            Booking.State s = b.state();
            BigDecimal base = s.baseAmount, gst = s.gstAmount, dep = s.depositAmount;
            BigDecimal old = b.adjustFee(newFee, reason, clock.instant());
            ledger.uncharge(b, old, nz(base), nz(gst), nz(dep), BigDecimal.ZERO, clock.instant(), "Fee corrected");
            ledger.charge(b, clock.instant());
            return "Fee corrected from " + s.feeCorrectedFrom.toPlainString() + " to " + s.feeTotal.toPlainString() + ": " + s.feeCorrectionReason;
        });
    }

    private Booking change(Caller c, UUID id, long version, Function<Booking, String> work) {
        return tx.inTx(() -> {
            Booking b = bookings.get(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
            if (b.version() != version) throw new DomainException.Conflict("Booking " + b.shortId());
            String what = work.apply(b);
            if (!bookings.save(b)) throw new DomainException.Conflict("Booking " + b.shortId());
            done(c, b, AuditWriter.Action.Update, "changed", what + " - " + b.shortId());
            return b;
        });
    }
    private void requireStaff(Caller c) { if (!BookingPolicy.staff(c)) throw new AccessDenied("Requires amenities management access"); }
    private void done(Caller c, Booking b, AuditWriter.Action a, String verb, String summary) {
        Booking.State s = b.state();
        events.publish(List.of(new BookingEvents("amenity.booking." + ("Cancelled".equals(s.status) ? "cancelled" : verb), b.id(), c.community(), s.amenityTypeId, s.date, s.status, s.paymentStatus, clock.instant())));
        audit.write(c, a, "amenity.booking", b.id(), b.shortId(), b.unit() == null ? null : b.unit().value(), summary, List.of(new AuditWriter.Change("status", null, s.status)));
    }
    /** Two slots clash when they are the same, or one of them is the whole day. */
    static boolean overlaps(String a, String b) { return a.equals(b) || "Full day".equals(a) || "Full day".equals(b); }
    static BigDecimal nz(BigDecimal b) { return b == null ? BigDecimal.ZERO : b; }
}
