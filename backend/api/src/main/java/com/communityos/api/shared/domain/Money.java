package com.communityos.api.shared.domain;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Objects;

/** An amount of money in the community's currency: always 2 decimals, never a double. Value object (immutable, equal by value). */
public record Money(BigDecimal amount) implements Comparable<Money> {
    public static final Money ZERO = new Money(BigDecimal.ZERO);

    public Money {
        Objects.requireNonNull(amount, "amount");
        amount = amount.setScale(2, RoundingMode.HALF_EVEN);
    }
    public static Money of(String s) { return new Money(new BigDecimal(s)); }
    public static Money of(long rupees) { return new Money(BigDecimal.valueOf(rupees)); }

    public Money plus(Money o) { return new Money(amount.add(o.amount)); }
    public Money minus(Money o) { return new Money(amount.subtract(o.amount)); }
    public Money times(BigDecimal factor) { return new Money(amount.multiply(factor)); }
    /** Tax or a share: amount x percent / 100, rounded half-even to the paisa. */
    public Money percent(BigDecimal pct) { return new Money(amount.multiply(pct).divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_EVEN)); }
    public Money min(Money o) { return compareTo(o) <= 0 ? this : o; }
    public boolean isNegative() { return amount.signum() < 0; }
    public boolean isZero() { return amount.signum() == 0; }
    public boolean isPositive() { return amount.signum() > 0; }
    @Override public int compareTo(Money o) { return amount.compareTo(o.amount); }
    @Override public String toString() { return amount.toPlainString(); }
}
