package com.communityos.api.finance;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.finance.application.FinancePolicy;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** Taxes on a cash book entry, its journal lines and its reversal; who reads and writes the books. */
class FinanceTest {
    static Books.Entry out() {
        Books.Entry e = new Books.Entry(); e.date = LocalDate.of(2026, 10, 20); e.type = "Debit"; e.description = " Pipes "; e.baseAmount = new BigDecimal("10000");
        e.gstRate = new BigDecimal("18"); e.tdsRate = new BigDecimal("2"); e.tdsSection = "194C"; return e;
    }
    static Money side(java.util.List<Journal.Line> ls, String code, boolean debit) {
        return ls.stream().filter((l) -> code.equals(l.accountCode())).map((l) -> debit ? l.debit() : l.credit()).reduce(Money.ZERO, Money::plus);
    }
    @Test void taxes() {
        Books.Entry e = out(); e.check();
        assertEquals(new BigDecimal("1800.00"), e.gstAmount); assertEquals(new BigDecimal("200.00"), e.tdsAmount); assertEquals(new BigDecimal("11600.00"), e.amount); assertEquals("Pipes", e.description);
        var ls = e.lines();
        new Journal.Entry(e.date, "x", "cashbook", null, ls);   // balanced, or the constructor refuses it
        assertEquals(Money.of("10000"), side(ls, "5000", true)); assertEquals(Money.of("1800"), side(ls, "1300", true));
        assertEquals(Money.of("11600"), side(ls, "1000", false)); assertEquals(Money.of("200"), side(ls, "2150", false));
        e.shortId = "CB-1";
        Books.Entry r = e.reversal(LocalDate.of(2026, 10, 21), "twice");
        assertEquals("Credit", r.type); assertEquals("CB-1", r.reversalOf); assertEquals(e.amount, r.amount);
        var back = e.swapped();
        new Journal.Entry(r.date, "x", "cashbook", null, back);
        assertEquals(Money.of("10000"), side(back, "5000", false), "the expense comes off, it is not booked as income");
        Books.Entry in = new Books.Entry(); in.date = e.date; in.type = "Credit"; in.description = "Hall hire"; in.amount = new BigDecimal("500"); in.tdsRate = BigDecimal.TEN; in.check();
        assertEquals(BigDecimal.ZERO, in.tdsAmount, "no base, no tax worked out"); assertEquals(Money.of("500"), side(in.lines(), "4900", false));
        Books.Entry bad = out(); bad.type = "Sideways"; assertEquals("bad-type", assertThrows(DomainException.RuleViolated.class, bad::check).code());
        Books.Entry none = new Books.Entry(); none.date = e.date; none.type = "Debit"; none.description = "x";
        assertEquals("amount-required", assertThrows(DomainException.RuleViolated.class, none::check).code());
        Books.Entry cult = out(); cult.module = "Cultural"; cult.check(); assertEquals(Money.of("10000"), side(cult.lines(), "5100", true), "event spending on its own account");
    }
    @Test void policy() {
        assertTrue(FinancePolicy.reader(Fixtures.treasurer())); assertFalse(FinancePolicy.writer(Fixtures.caller(Caller.Category.EC, Set.of("president"), Set.of(), Set.of())));
        assertTrue(FinancePolicy.writer(Fixtures.treasurer()), "MANAGE_LEDGER"); assertFalse(FinancePolicy.reader(Fixtures.owner(Fixtures.UNIT_A)));
        assertTrue(FinancePolicy.raisesRelease(Fixtures.caller(Caller.Category.Staff, Set.of("x"), Set.of(), Set.of(), Permission.MANAGE_CULTURAL), true));
        assertFalse(FinancePolicy.raisesRelease(Fixtures.caller(Caller.Category.Staff, Set.of("x"), Set.of(), Set.of(), Permission.MANAGE_CULTURAL), false));
        Books.BankLine l = new Books.BankLine(null, null, null, null, null, null, new BigDecimal("5"), null, null, null, null, null, 0);
        assertTrue(l.out()); assertEquals(new BigDecimal("5"), l.value());
    }
}
