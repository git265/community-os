package com.communityos.api.billing.application;

import com.communityos.api.billing.application.port.JournalWriter;
import com.communityos.api.billing.domain.BillingEvents.DueCancelled;
import com.communityos.api.billing.domain.BillingEvents.DueRaised;
import com.communityos.api.billing.domain.BillingEvents.DueWaived;
import com.communityos.api.billing.domain.BillingEvents.PaymentRecorded;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.billing.domain.Journal.Line;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEventHandler;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Observer: turns billing facts into double-entry journal entries, in the same transaction (a bill and its ledger entry commit together or not
 * at all). Accounts follow the seeded chart: 1000 Bank, 1100 Members receivable, 1200 Gateway clearing, 2000 Advances from members,
 * 2100 Tax payable, 5000 Operating expenses (write-offs); income per charge category.
 */
public final class LedgerPoster {
    private final JournalWriter journal; private final ZoneId zone;
    public LedgerPoster(JournalWriter journal, ZoneId zone) { this.journal = journal; this.zone = zone; }

    public List<DomainEventHandler<?>> handlers() {
        return List.of(handler(DueRaised.class, this::onRaised), handler(DueCancelled.class, this::onCancelled),
                       handler(DueWaived.class, this::onWaived), handler(PaymentRecorded.class, this::onPayment));
    }

    void onRaised(DueRaised e) {
        UUID unit = e.unitId() == null ? null : e.unitId().value();
        journal.post(new Journal.Entry(e.occurredAt().atZone(zone).toLocalDate(), "Bill raised", "due", e.dueId().value(), List.of(
            Line.debit("1100", unit, e.amount().plus(e.tax()), "Receivable"),
            Line.creditId(e.incomeAccountId(), unit, e.amount(), "Income"),
            Line.credit("2100", unit, e.tax(), "Tax"))));
    }
    void onCancelled(DueCancelled e) {
        UUID unit = e.unitId() == null ? null : e.unitId().value();
        journal.post(new Journal.Entry(e.occurredAt().atZone(zone).toLocalDate(), "Bill cancelled: " + e.reason(), "due", e.dueId().value(), List.of(
            Line.debitId(e.incomeAccountId(), unit, e.amount(), "Income reversed"),
            Line.debit("2100", unit, e.tax(), "Tax reversed"),
            Line.credit("1100", unit, e.amount().plus(e.tax()), "Receivable cleared"))));
    }
    void onWaived(DueWaived e) {
        if (!e.waived().isPositive()) return;
        UUID unit = e.unitId() == null ? null : e.unitId().value();
        journal.post(new Journal.Entry(e.occurredAt().atZone(zone).toLocalDate(), "Bill waived: " + e.reason(), "due", e.dueId().value(), List.of(
            Line.debit("5000", unit, e.waived(), "Written off"),
            Line.credit("1100", unit, e.waived(), "Receivable cleared"))));
    }
    void onPayment(PaymentRecorded e) {
        UUID unit = e.unitId() == null ? null : e.unitId().value();
        Money allocated = e.allocations().stream().map((a) -> a.amount()).reduce(Money.ZERO, Money::plus);
        List<Line> lines = new ArrayList<>();
        lines.add(Line.debit(e.viaGateway() ? "1200" : "1000", unit, e.amount(), e.viaGateway() ? "Received via " + e.provider() : "Received: " + e.method()));
        lines.add(Line.credit("1100", unit, allocated, "Bills settled"));
        lines.add(Line.credit("2000", unit, e.toCredit(), "Advance kept as unit credit"));
        journal.post(new Journal.Entry(e.occurredAt().atZone(zone).toLocalDate(), "Payment " + e.receiptNo(), "payment", e.paymentId().value(), lines));
    }

    private static <E extends DomainEvent> DomainEventHandler<E> handler(Class<E> type, java.util.function.Consumer<E> f) {
        return new DomainEventHandler<>() {
            @Override public Class<E> eventType() { return type; }
            @Override public void on(E event) { f.accept(event); }
        };
    }
}
