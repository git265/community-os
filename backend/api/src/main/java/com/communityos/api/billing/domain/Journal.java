package com.communityos.api.billing.domain;

import com.communityos.api.shared.domain.Money;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** A double-entry journal entry as the ledger poster builds it. It must balance before it is even sent to the database (which checks again). */
public final class Journal {
    private Journal() {}
    /** One side of a line: an account by its code (1100) or, for category income, by id. */
    public record Line(String accountCode, UUID accountId, UUID unitId, Money debit, Money credit, String narration) {
        public Line {
            if ((accountCode == null) == (accountId == null)) throw new IllegalArgumentException("an account code or id");
            if (debit.isNegative() || credit.isNegative() || (debit.isPositive() && credit.isPositive())) throw new IllegalArgumentException("one side per line");   // all-zero lines are dropped by Entry
        }
        public static Line debit(String code, UUID unit, Money m, String text) { return new Line(code, null, unit, m, Money.ZERO, text); }
        public static Line credit(String code, UUID unit, Money m, String text) { return new Line(code, null, unit, Money.ZERO, m, text); }
        public static Line debitId(UUID account, UUID unit, Money m, String text) { return new Line(null, account, unit, m, Money.ZERO, text); }
        public static Line creditId(UUID account, UUID unit, Money m, String text) { return new Line(null, account, unit, Money.ZERO, m, text); }
    }
    public record Entry(LocalDate date, String memo, String sourceType, UUID sourceId, List<Line> lines) {
        public Entry {
            lines = lines.stream().filter((l) -> l.debit().isPositive() || l.credit().isPositive()).toList();
            Money d = lines.stream().map(Line::debit).reduce(Money.ZERO, Money::plus), c = lines.stream().map(Line::credit).reduce(Money.ZERO, Money::plus);
            if (lines.size() < 2 || d.compareTo(c) != 0) throw new IllegalStateException("journal entry does not balance: debit " + d + ", credit " + c);
        }
    }
}
