package com.communityos.api.amenity;

import static com.communityos.api.Fixtures.*;
import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.amenity.application.AmenityLedger;
import com.communityos.api.amenity.application.BookingService;
import com.communityos.api.amenity.application.port.AmenityCatalog;
import com.communityos.api.amenity.application.port.BookingRepository;
import com.communityos.api.amenity.domain.AmenityType;
import com.communityos.api.amenity.domain.Booking;
import com.communityos.api.amenity.domain.Pricing;
import com.communityos.api.billing.application.BillingDesk;
import com.communityos.api.billing.application.LedgerPoster;
import com.communityos.api.billing.application.TargetSettlement;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.domain.Ids.PaymentId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Amenity pricing and the booking workflow, with the real billing desk and ledger poster on in-memory adapters (the ledger must balance). */
class AmenityTest {
    static final ZoneId IST = ZoneId.of("Asia/Kolkata");
    static final UUID HALL = UUID.randomUUID(), COURT = UUID.randomUUID(), CHAIRS = UUID.randomUUID();
    static AmenityType hall(int capacity) {
        return new AmenityType(HALL, "Party Hall", true, new BigDecimal("5000"), "Per day / event", new BigDecimal("6000"), true, new BigDecimal("18"), "Exclusive", new BigDecimal("2000"),
            List.of(), 24, 90, capacity, "09:00–23:00", "Full day", "Reservation required", List.of(), new BigDecimal("1"), null, new BigDecimal("2"), List.of("2026-12-25"), List.of(), List.of());
    }
    static AmenityType court() {
        return new AmenityType(COURT, "Tennis Court", true, BigDecimal.ZERO, "Free", null, false, null, null, null, List.of(), 0, 7, 1, "06:00–22:00", "Time slot", "Reservation required",
            List.of(), null, null, null, List.of(), List.of(), List.of("06:00–07:00", "07:00–08:00"));
    }

    // ---- pricing ----------------------------------------------------------------------------------------------------------------------------------
    @Test void pricing() {
        Pricing.Quote wk = Pricing.quote(hall(1), LocalDate.of(2026, 10, 27), null, new BigDecimal("300"));   // a Tuesday
        assertEquals("5300.00", wk.base().toPlainString()); assertEquals("954.00", wk.gst().toPlainString()); assertEquals("6254.00", wk.fee().toPlainString());
        assertEquals("8254.00", wk.total().toPlainString(), "fee + the deposit");
        Pricing.Quote sat = Pricing.quote(hall(1), LocalDate.of(2026, 10, 31), null, BigDecimal.ZERO);
        assertTrue(sat.weekend()); assertEquals("7080.00", sat.fee().toPlainString());
        AmenityType incl = new AmenityType(HALL, "Hall", true, new BigDecimal("1180"), null, null, true, new BigDecimal("18"), "Inclusive", null, List.of(), null, null, 1, null, null, null,
            List.of(), null, null, null, List.of(), List.of(), List.of());
        Pricing.Quote q = Pricing.quote(incl, LocalDate.of(2026, 10, 27), null, null);
        assertEquals("1000.00", q.base().toPlainString()); assertEquals("180.00", q.gst().toPlainString()); assertEquals("1180.00", q.fee().toPlainString());
        assertTrue(Pricing.quote(court(), LocalDate.of(2026, 10, 27), null, null).free());
        assertEquals("Full day", Pricing.checkSlot(hall(1), null));
        assertThrows(DomainException.RuleViolated.class, () -> Pricing.checkSlot(court(), "09:00–10:00"), "not one of its slots");
        Instant start = Pricing.startAt(LocalDate.of(2026, 10, 27), "Full day", hall(1), IST);
        assertEquals(Instant.parse("2026-10-27T03:30:00Z"), start, "a full day starts at opening time, local");
        Instant now = Instant.parse("2026-10-26T10:00:00Z");
        assertEquals("This amenity must be booked at least 24 hours ahead.", Pricing.windowError(hall(1), start, now));
        assertNull(Pricing.windowError(hall(1), start, now.minusSeconds(86400)));
        assertTrue(Pricing.limitsError(hall(1), LocalDate.of(2026, 12, 25), "Villa", List.of(), LocalDate.of(2026, 10, 20)).contains("closed"));
        assertTrue(Pricing.limitsError(hall(1), LocalDate.of(2026, 11, 3), "Villa", List.of(new Pricing.Held(LocalDate.of(2026, 11, 1), false), new Pricing.Held(LocalDate.of(2026, 11, 2), false)),
            LocalDate.of(2026, 10, 20)).contains("upcoming"));
        // cancellation: default tiers 72 h 100%, 24 h 50%, else nothing; the deposit always back
        Pricing.CancelQuote half = Pricing.cancellation(hall(1).tiers(), start, start.minusSeconds(30 * 3600), new BigDecimal("5900"), new BigDecimal("2000"), false);
        assertEquals("50", half.pct().toPlainString()); assertEquals("2950.00", half.refundFee().toPlainString()); assertEquals("2000.00", half.refundDeposit().toPlainString());
        assertEquals("0.00", Pricing.cancellation(hall(1).tiers(), start, start.minusSeconds(3600), new BigDecimal("5900"), BigDecimal.ZERO, false).refundFee().toPlainString());
        // add-ons priced from the catalog, stock shared with overlapping bookings
        List<Pricing.Item> cat = List.of(new Pricing.Item(CHAIRS, "Chairs", null, new BigDecimal("100"), new BigDecimal("15"), new BigDecimal("80"), true));
        Pricing.Extras ex = Pricing.price(Map.of(CHAIRS, 50), cat, HALL, Map.of(CHAIRS, 40));
        assertEquals("750.00", ex.total().toPlainString());
        assertTrue(assertThrows(DomainException.RuleViolated.class, () -> Pricing.price(Map.of(CHAIRS, 61), cat, HALL, Map.of(CHAIRS, 40))).getMessage().contains("Only 60"));
        assertThrows(DomainException.RuleViolated.class, () -> Pricing.price(Map.of(CHAIRS, 81), cat, HALL, Map.of()), "at most 80 per booking");
    }

    // ---- the workflow ---------------------------------------------------------------------------------------------------------------------------
    final Map<UUID, Booking> rows = new LinkedHashMap<>();
    final BookingRepository repo = new BookingRepository() {
        int n;
        public List<Booking> find(Spec<Booking> s, Filter f) { return rows.values().stream().filter(s::matches).toList(); }
        public Optional<Booking> get(UUID id, Spec<Booking> s) { return Optional.ofNullable(rows.get(id)).filter(s::matches); }
        public void insert(Booking b) { b.state().shortId = "BKG-" + (++n); b.state().version = 1; rows.put(b.id(), b); }
        public boolean save(Booking b) { b.state().version++; return true; }
        public List<Booking> liveOn(UUID a, LocalDate d) { return rows.values().stream().filter((b) -> b.state().amenityTypeId.equals(a) && b.state().date.equals(d) && !"Cancelled".equals(b.status())).toList(); }
        public List<Pricing.Held> heldBy(UUID a, UnitId u) { return rows.values().stream().filter((b) -> b.state().amenityTypeId.equals(a) && u.equals(b.unit()) && !"Cancelled".equals(b.status())).map((b) -> new Pricing.Held(b.state().date, "Completed".equals(b.status()))).toList(); }
        public List<Taken> taken(UUID a, LocalDate f, LocalDate t) { return List.of(); }
    };
    AmenityType hallNow = hall(1);
    String hold = null;
    final AmenityCatalog catalog = new AmenityCatalog() {
        public Optional<AmenityType> lockType(UUID id) { return type(id); }
        public Optional<AmenityType> type(UUID id) { return id.equals(HALL) ? Optional.of(hallNow) : id.equals(COURT) ? Optional.of(court()) : Optional.empty(); }
        public List<Pricing.Item> items() { return List.of(new Pricing.Item(CHAIRS, "Chairs", null, new BigDecimal("100"), new BigDecimal("15"), null, true)); }
        public Settings settings() { return new Settings(new BigDecimal("18"), false, 24); }
        public Optional<UnitInfo> unit(UnitId u) { return Optional.of(new UnitInfo(u, u.equals(UNIT_A) ? "Villa 1" : "Villa 2", "Villa", null)); }
        public String defaulterHold(UnitId u, LocalDate today) { return hold; }
    };
    final Fixtures.Payments payments = new Fixtures.Payments();
    final Fixtures.Journals journals = new Fixtures.Journals();
    final DomainEvents events = Fixtures.events(new LedgerPoster(journals, IST).handlers(), new Fixtures.Outbox());
    final BillingDesk desk = new BillingDesk(payments, new TargetSettlement(new Fixtures.Dues(), payments, events, new Fixtures.Audit(), Tx.direct(), CLOCK), journals, events, CLOCK);
    final BookingService svc = new BookingService(repo, catalog, desk, new AmenityLedger(desk, IST), events, new Fixtures.Audit(), Tx.direct(), CLOCK, IST);
    final Caller owner = owner(UNIT_A), neighbour = owner(UNIT_B);
    final Caller team = caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of(), Permission.MANAGE_AMENITIES);
    static final LocalDate DAY = LocalDate.of(2026, 10, 27);

    /** account code -> debit minus credit, over every journal entry posted */
    Map<String, BigDecimal> balances() {
        Map<String, BigDecimal> m = new HashMap<>();
        for (Journal.Entry e : journals.entries) for (Journal.Line l : e.lines()) m.merge(l.accountCode() == null ? "id" : l.accountCode(), l.debit().amount().subtract(l.credit().amount()), BigDecimal::add);
        return m;
    }
    BigDecimal bal(String code) { return balances().getOrDefault(code, BigDecimal.ZERO).setScale(2); }
    BookingService.Book book(UnitId unit, String mode, UUID prepay, boolean credit) { return new BookingService.Book(HALL, unit, DAY, null, mode, prepay, credit, "Unit", null, false, null, Map.of()); }

    @Test void officePaymentThenCancelThenRefund() {
        Booking b = svc.book(owner, book(UNIT_A, "Cash", null, false));
        assertEquals("Pending payment", b.status()); assertEquals("Pending", b.state().paymentStatus); assertEquals("7900.00", b.total().toPlainString());
        assertEquals("7900.00", bal("1100").toPlainString(), "the unit owes it from the start");
        assertEquals("-2000.00", bal("2200").toPlainString()); assertEquals("-900.00", bal("2100").toPlainString()); assertEquals("-5000.00", bal("4200").toPlainString());
        assertThrows(DomainException.RuleViolated.class, () -> svc.book(neighbour, book(UNIT_B, "Cash", null, false)), "full: capacity 1");
        assertThrows(AccessDenied.class, () -> svc.book(owner, book(UNIT_B, "Cash", null, false)), "not my unit");
        assertThrows(AccessDenied.class, () -> svc.receivePayment(owner, b.id(), b.version(), "Cash", null), "the team records payments");
        Booking paid = svc.receivePayment(team, b.id(), b.version(), "Cash", null);
        assertEquals("Confirmed", paid.status()); assertEquals("Held", paid.state().depositStatus);
        assertEquals("0.00", bal("1100").toPlainString()); assertEquals("7900.00", bal("1000").toPlainString());
        // cancelled 30 h before (default tiers): half the fee back, all of the deposit; to the original mode -> payable
        Instant now = CLOCK.instant();
        assertTrue(now.isBefore(b.state().startAt));
        Booking c = svc.cancel(owner, b.id(), paid.version(), new BookingService.Cancel("plans changed", null, false, null));
        assertEquals("Refund due", c.state().refundStatus); assertEquals("100", c.state().refundPct.stripTrailingZeros().toPlainString(), "a week ahead: the 72 h tier");
        assertEquals("7900.00", c.state().refundAmount.toPlainString()); assertEquals("Returned", c.state().depositStatus);
        assertEquals("-7900.00", bal("2400").toPlainString()); assertEquals("0.00", bal("4200").toPlainString()); assertEquals("0.00", bal("2200").toPlainString());
        Booking out = svc.refundPaid(team, b.id(), c.version(), "Cheque", "000123", false);
        assertEquals("Refunded", out.state().refundStatus); assertEquals("0.00", bal("2400").toPlainString()); assertEquals("0.00", bal("1000").toPlainString());
        assertEquals(BigDecimal.ZERO.setScale(2), balances().values().stream().reduce(BigDecimal.ZERO, BigDecimal::add).setScale(2), "the books balance");
    }

    @Test void prepaymentAndCreditAndDeposit() {
        // an online payment made first: its money waits as the unit's credit until this booking claims it
        PaymentId pre = PaymentId.random();
        payments.insert(new PaymentRepository.NewPayment(pre, OrderId.random(), UNIT_A, Money.of("8000"), "UPI", "simulated", "sim_pay_9", CLOCK.instant(), null));
        payments.creditUnit(UNIT_A, Money.of("8000"), pre, "prepayment");
        assertThrows(DomainException.RuleViolated.class, () -> svc.book(owner, book(UNIT_A, "UPI", null, false)), "pay online first");
        Booking b = svc.book(owner, book(UNIT_A, "UPI", pre.value(), false));
        assertEquals("Confirmed", b.status()); assertEquals("Paid", b.state().paymentStatus); assertEquals(pre.value(), b.state().paymentId);
        assertEquals("100.00", desk.credit(UNIT_A).amount().toPlainString(), "8000 paid, 7900 used: the rest stays as credit");
        assertThrows(DomainException.RuleViolated.class, () -> svc.book(owner, new BookingService.Book(HALL, UNIT_A, DAY.plusDays(1), null, "UPI", pre.value(), false, "Unit", null, false, null, Map.of())),
            "a prepayment is claimed once");
        // the deposit: 500 kept for damage, the rest back to the original mode -> payable, then paid
        assertThrows(DomainException.RuleViolated.class, () -> svc.settleDeposit(team, b.id(), b.version(), new BigDecimal("500"), " ", null), "a deduction needs a reason");
        Booking d = svc.settleDeposit(team, b.id(), b.version(), new BigDecimal("500"), "Broken chair", "UPI");
        assertEquals("Partly forfeited", d.state().depositStatus); assertEquals("Due", d.state().depositRefundStatus); assertEquals("Completed", d.status());
        assertThrows(DomainException.RuleViolated.class, () -> svc.depositPaid(team, b.id(), d.version(), null, null, true), "no refunds through the provider without it (the flow test has them)");
        Booking back = svc.depositPaid(team, b.id(), d.version(), "UPI", "UTR 5521", false);
        assertEquals("Paid", back.state().depositRefundStatus); assertEquals("UTR 5521", back.state().depositRefundRef);
        assertEquals("-5500.00", bal("4200").toPlainString(), "the fee and the kept part of the deposit are income");
        assertEquals("0.00", bal("2200").toPlainString()); assertEquals("0.00", bal("1100").toPlainString());
        assertEquals(BigDecimal.ZERO.setScale(2), balances().values().stream().reduce(BigDecimal.ZERO, BigDecimal::add).setScale(2));
        // unit credit pays a free-standing booking; cancelling it puts the credit back
        payments.creditUnit(UNIT_B, Money.of("10000"), PaymentId.random(), "overpayment");
        Booking cr = svc.book(neighbour, new BookingService.Book(HALL, UNIT_B, DAY.plusDays(7), null, "Cash", null, true, "Unit", null, false, null, Map.of(CHAIRS, 10)));
        assertEquals("Unit credit", cr.state().paymentMode); assertEquals("8077.00", cr.total().toPlainString(), "5150 + 18% + 2000"); assertEquals("1923.00", desk.credit(UNIT_B).amount().toPlainString());
        Booking crc = svc.cancel(neighbour, cr.id(), cr.version(), new BookingService.Cancel(null, null, false, null));
        assertEquals("Credited to unit account", crc.state().refundStatus, "paid from credit: back to the account");
        assertEquals("10000.00", desk.credit(UNIT_B).amount().toPlainString());
    }

    @Test void whoMayDoWhat() {
        assertThrows(AccessDenied.class, () -> svc.book(owner, new BookingService.Book(HALL, null, DAY, null, "Cash", null, false, "Association", "RWA", false, null, Map.of())));
        assertThrows(DomainException.RuleViolated.class, () -> svc.book(team, new BookingService.Book(HALL, null, DAY, null, "Cash", null, false, "Association", "RWA", false, null, Map.of())),
            "an association booking is free of charge");
        Booking rwa = svc.book(team, new BookingService.Book(HALL, null, DAY, null, null, null, false, "Association", "RWA", true, "Annual meeting", Map.of()));
        assertTrue(rwa.state().chargeWaived); assertEquals("7900.00", rwa.state().waivedAmount.toPlainString()); assertEquals("Not required", rwa.state().paymentStatus);
        assertTrue(journals.entries.isEmpty(), "nothing charged, nothing posted");
        hold = "This unit has 4000 of overdue dues";
        assertTrue(assertThrows(DomainException.RuleViolated.class, () -> svc.book(owner, new BookingService.Book(COURT, UNIT_A, DAY, "06:00–07:00", null, null, false, "Unit", null, false, null, Map.of())))
            .getMessage().contains("overdue"));
        hold = null;
        Booking court = svc.book(owner, new BookingService.Book(COURT, UNIT_A, DAY, "06:00–07:00", null, null, false, "Unit", null, false, null, Map.of()));
        assertEquals("Not required", court.state().paymentStatus);
        assertEquals(1, svc.list(owner, new BookingRepository.Filter(null, null, null, null, null, false)).size(), "a resident sees their own");
        assertEquals(2, svc.list(team, new BookingRepository.Filter(null, null, null, null, null, false)).size());
        assertThrows(AccessDenied.class, () -> svc.cancel(neighbour, court.id(), court.version(), new BookingService.Cancel(null, null, false, null)));
        assertThrows(DomainException.RuleViolated.class, () -> svc.cancel(team, court.id(), court.version(), new BookingService.Cancel(" ", null, false, null)), "the team gives a reason");
    }
}
