package com.communityos.api.billing.application;

import com.communityos.api.billing.application.port.JournalWriter;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.domain.BillingEvents.CreditApplied;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.PaymentId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.Caller;
import java.time.Clock;
import java.util.List;
import java.util.UUID;

/**
 * Facade: what other modules (amenities, cultural) use of billing - a unit's credit, prepayments, office receipts and the ledger. Everything
 * runs inside the caller's transaction; the owning module has already checked who may do it.
 */
public final class BillingDesk {
    private final PaymentRepository payments; private final TargetSettlement counter; private final JournalWriter journal; private final DomainEvents events; private final Clock clock;
    public BillingDesk(PaymentRepository payments, TargetSettlement counter, JournalWriter journal, DomainEvents events, Clock clock) {
        this.payments = payments; this.counter = counter; this.journal = journal; this.events = events; this.clock = clock;
    }

    /** The unit's credit now; locks the unit so a concurrent use waits. */
    public Money credit(UnitId unit) { return payments.lockCreditBalance(unit); }

    /** Pay `amount` of what a booking / donation owes from the unit's credit (refused when the credit is not enough). */
    public void useCredit(Caller c, UnitId unit, Money amount, String targetType, UUID targetId, String reason) {
        if (!amount.isPositive()) return;
        Money have = payments.lockCreditBalance(unit);
        if (have.compareTo(amount) < 0) throw new DomainException.RuleViolated("not-enough-credit", "The unit has only " + have + " of credit");
        payments.creditRow(unit, Money.ZERO.minus(amount), "applied-to-" + targetType, targetId, reason);
        events.publish(List.of(new CreditApplied(targetId, c.community(), unit, amount, targetType, targetId, clock.instant())));
    }

    /**
     * Use a prepayment (an online payment made for this purpose before the record existed): it must be this unit's, of this purpose, not yet
     * claimed, and at least `owed`. Whatever it paid above `owed` stays the unit's credit.
     */
    public void usePrepayment(Caller c, UnitId unit, UUID paymentId, String purpose, Money owed, String targetType, UUID targetId, String reason) {
        Money paid = payments.claim(new PaymentId(paymentId), unit, purpose, targetType, targetId)
            .orElseThrow(() -> new DomainException.RuleViolated("bad-prepayment", "That payment cannot be used here: it is not this unit's, not for a " + purpose + ", or already used"));
        if (paid.compareTo(owed) < 0) throw new DomainException.RuleViolated("prepayment-short", "The payment (" + paid + ") is less than the price (" + owed + ") - it is kept as the unit's credit");
        useCredit(c, unit, owed, targetType, targetId, reason);
    }

    /** Money received at the office for a booking / donation; returns the receipt. */
    public PaymentRepository.Receipt receive(Caller c, UnitId unit, Money amount, String method, String reference, String targetType, UUID targetId, Money owed) {
        return counter.settle(c, new TargetSettlement.Request(unit, amount, method, reference, targetType, targetId, owed));
    }

    /** Give money back to the unit as credit (a refund to the unit account). The ledger entry is the owning module's. */
    public void creditUnit(UnitId unit, Money amount, String sourceType, UUID sourceId, String reason) {
        if (amount.isPositive()) payments.creditRow(unit, amount, sourceType, sourceId, reason);
    }

    public void post(Journal.Entry e) { journal.post(e); }
}
