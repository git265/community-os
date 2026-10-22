package com.communityos.api.billing.application;

import com.communityos.api.billing.UtilityResources;
import com.communityos.api.billing.application.port.ReadingStore;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Publishing meter readings: the SERVER prices each bill from the utility's rate card (units x rate + fixed charge + the card's flat tax,
 * to the rupee, as the screen shows it), raises it, and marks the reading Published with the bill - all in one transaction per reading, so a
 * failure never leaves a bill without its reading or a reading published twice. Water and DG readings need a meter photo.
 */
public final class ReadingPublisher {
    public static final List<String> PHOTO_REQUIRED = List.of("water", "dg");
    public record Result(UUID readingId, String readingShortId, boolean published, String billShortId, BigDecimal amount, String reason) {}

    private final ReadingStore store; private final DueService dues; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public ReadingPublisher(ReadingStore store, DueService dues, AuditWriter audit, Tx tx, Clock clock) { this.store = store; this.dues = dues; this.audit = audit; this.tx = tx; this.clock = clock; }

    /** The bill for these units on this rate card. */
    public static Money price(BigDecimal units, ReadingStore.RateCard card) {
        BigDecimal v = units.multiply(card.ratePerUnit()).add(nz(card.fixedCharge())).add(nz(card.tax()));
        return new Money(v.setScale(0, RoundingMode.HALF_UP).setScale(2, RoundingMode.UNNECESSARY));
    }

    /** Publish each reading on its own: one that cannot be published says why, the others go ahead. */
    public List<Result> publish(Caller c, List<UUID> ids, LocalDate dueDate) {
        if (!UtilityResources.writers(c)) throw new AccessDenied("Only the meter readers and billing publish readings");
        if (ids == null || ids.isEmpty()) throw new DomainException.RuleViolated("none", "Choose the readings to publish");
        if (ids.size() > 1000) throw new DomainException.RuleViolated("too-many", "Publish up to 1000 readings at a time");
        LocalDate today = LocalDate.now(clock);
        if (dueDate == null || dueDate.isBefore(today)) throw new DomainException.RuleViolated("bad-due-date", "The payable-by date is today or later");
        List<Result> out = new ArrayList<>();
        for (UUID id : ids) {
            try { out.add(tx.inTx(() -> one(c, id, dueDate, today))); }
            catch (DomainException e) { out.add(new Result(id, null, false, null, null, e.getMessage())); }
        }
        return out;
    }

    private Result one(Caller c, UUID id, LocalDate dueDate, LocalDate today) {
        ReadingStore.Draft r = store.lock(id).orElseThrow(() -> new DomainException.NotFound("Reading"));
        if ("Published".equals(r.status())) throw new DomainException.RuleViolated("published", "Reading " + r.shortId() + " is already published");
        if (r.units() == null || r.units().signum() < 0) throw new DomainException.RuleViolated("no-units", "Reading " + r.shortId() + " has no units consumed");
        if (PHOTO_REQUIRED.contains(r.utility().toLowerCase(java.util.Locale.ROOT)) && store.photos(id) == 0)
            throw new DomainException.RuleViolated("photo-required", "Reading " + r.shortId() + " needs a meter photo before it is billed");
        ReadingStore.RateCard card = store.rateCard(r.utility()).orElseThrow(() -> new DomainException.RuleViolated("no-rate-card", "Set the " + r.utility() + " rate card first"));
        Money amount = price(r.units(), card);
        LocalDate month = LocalDate.parse(r.month() + "-01");
        String line = r.utility() + " " + month.getMonth().getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.ENGLISH) + " " + month.getYear() + ": meter "
            + plain(r.previous()) + " → " + plain(r.current()) + " = " + plain(r.units()) + " " + store.unitName(r.utility());
        Due bill = dues.raise(c, new DueService.RaiseDue(new UnitId(r.unitId()), r.utility(), month, line, amount, dueDate));
        store.linkBill(bill.id().value(), id);
        if (!store.published(id, r.version(), bill.id().value(), today)) throw new DomainException.Conflict("Reading " + r.shortId());
        audit.write(c, AuditWriter.Action.Update, "billing.meter_reading", id, r.shortId(), r.unitId(), "Published " + r.utility() + " " + r.month() + " as bill " + bill.shortId() + " (" + amount + ")",
            List.of(new AuditWriter.Change("status", "Draft", "Published")));
        return new Result(id, r.shortId(), true, bill.shortId(), amount.amount(), null);
    }
    private static BigDecimal nz(BigDecimal b) { return b == null ? BigDecimal.ZERO : b; }
    private static String plain(BigDecimal b) { return b == null ? "" : b.stripTrailingZeros().toPlainString(); }
}
