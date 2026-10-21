package com.communityos.api.assets.application;

import com.communityos.api.assets.AssetResources;
import com.communityos.api.assets.application.port.AssetStore;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;

/**
 * Stock and condition. An item's quantity changes only by a movement - received, issued (never below zero) or counted (the quantity found) -
 * and every movement is kept with who made it and the balance after it; falling to the minimum tells the coordinators. An asset's condition
 * changes by an entry in its condition log (found on an inspection, or by a task), which is kept too.
 */
public final class AssetService {
    public record StockEvent(String topic, UUID aggregateId, CommunityId communityId, String item, BigDecimal balance, BigDecimal minStock, String uom, Instant occurredAt) implements DomainEvent {}
    public record Moved(AssetStore.Stock item, AssetStore.Movement movement) {}

    private final AssetStore store; private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock; private final ZoneId zone;
    public AssetService(AssetStore store, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, ZoneId zone) {
        this.store = store; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock; this.zone = zone;
    }
    LocalDate today() { return LocalDate.now(clock.withZone(zone)); }

    public Moved move(Caller c, UUID itemId, String kind, BigDecimal quantity, LocalDate on, UUID ticketId, String vendor, String note) {
        if (!AssetPolicy.coordinator(c)) throw new AccessDenied("Only the EC, Facility Manager or MEP can update stock");
        if (!List.of("Received", "Issued", "Counted").contains(kind)) throw new DomainException.RuleViolated("bad-kind", "A movement is Received, Issued or Counted");
        if (quantity == null || quantity.signum() < 0 || (quantity.signum() == 0 && !"Counted".equals(kind))) throw new DomainException.RuleViolated("bad-quantity", "How many?");
        if (quantity.scale() > 3) throw new DomainException.RuleViolated("bad-quantity", "Up to 3 decimals");
        LocalDate day = on == null ? today() : on;
        if (day.isAfter(today())) throw new DomainException.RuleViolated("future", "A movement is for today or earlier");
        if (note != null && note.length() > 1000) throw new DomainException.RuleViolated("too-long", "The note is up to 1000 characters");
        return tx.inTx(() -> {
            AssetStore.Stock s = store.stock(itemId, true).orElseThrow(() -> new DomainException.NotFound("Item"));
            if (ticketId != null && !store.ticketExists(ticketId)) throw new DomainException.RuleViolated("bad-task", "No such task");
            BigDecimal balance = switch (kind) { case "Received" -> s.quantity().add(quantity); case "Issued" -> s.quantity().subtract(quantity); default -> quantity; };
            if (balance.signum() < 0) throw new DomainException.RuleViolated("not-enough", "Only " + s.quantity().stripTrailingZeros().toPlainString() + " " + s.uom() + " of " + s.item() + " in stock");
            AssetStore.Movement m = store.move(s, kind, quantity, balance, day, ticketId, blank(vendor), blank(note));
            AssetStore.Stock after = store.stock(itemId, false).orElseThrow();
            audit.write(c, AuditWriter.Action.Update, "assets.inventory_item", s.id(), s.shortId(), null,
                kind + " " + quantity.stripTrailingZeros().toPlainString() + " " + s.uom() + " of " + s.item() + " (now " + balance.stripTrailingZeros().toPlainString() + ")", List.of());
            if (after.low() && !s.low()) events.publish(List.of(new StockEvent("assets.stock.low", s.id(), c.community(), s.item(), balance, s.minStock(), s.uom(), clock.instant())));
            return new Moved(after, m);
        });
    }
    public List<AssetStore.Movement> movements(Caller c, UUID itemId) {
        if (!AssetPolicy.reader(c)) throw new AccessDenied.NotVisible();
        return store.movements(itemId);
    }

    /** Record what was found on an asset; its condition (and last inspection) follow when this is the latest news. */
    public AssetStore.ConditionEntry condition(Caller c, UUID assetId, LocalDate date, String condition, String source, String note, UUID ticketId) {
        if (!AssetPolicy.writer(c)) throw new AccessDenied("Only the EC, Facility Manager, MEP or the people who record readings log an asset's condition");
        if (!AssetResources.CONDITIONS.contains(condition)) throw new DomainException.RuleViolated("bad-condition", "Condition must be one of: " + String.join(", ", AssetResources.CONDITIONS));
        LocalDate day = date == null ? today() : date;
        if (day.isAfter(today())) throw new DomainException.RuleViolated("future", "The date is today or earlier");
        if (note != null && note.length() > 4000) throw new DomainException.RuleViolated("too-long", "The note is up to 4000 characters");
        return tx.inTx(() -> {
            AssetStore.Asset a = store.asset(assetId, true).orElseThrow(() -> new DomainException.NotFound("Asset"));
            if (ticketId != null && !store.ticketExists(ticketId)) throw new DomainException.RuleViolated("bad-task", "No such task");
            boolean latest = a.lastInspected() == null || !day.isBefore(a.lastInspected());
            AssetStore.ConditionEntry e = store.recordCondition(a, day, condition, blank(source), blank(note), ticketId, latest);
            audit.write(c, AuditWriter.Action.Update, "assets.equipment", a.id(), null, null, a.name() + ": " + condition + (latest && !condition.equals(a.status()) ? " (was " + a.status() + ")" : ""), List.of());
            return e;
        });
    }
    static String blank(String s) { return s == null || s.isBlank() ? null : s.strip(); }
}
