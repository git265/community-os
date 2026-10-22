package com.communityos.api.assets;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.assets.application.AssetPolicy;
import com.communityos.api.assets.application.AssetService;
import com.communityos.api.assets.application.port.AssetStore;
import com.communityos.api.comms.application.Recipes;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Worked-out values in the registers, who keeps what, stock movements and the condition log. */
class AssetTest {
    static final LocalDate TODAY = LocalDate.of(2026, 10, 20);
    static Caller fm() { return Fixtures.caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of()); }
    static Caller reader() { return Fixtures.caller(Caller.Category.Staff, Set.of("meter_reader"), Set.of(), Set.of(), Permission.MANAGE_UTILITY_READINGS); }

    @Test void registers() {
        Caller fm = fm();
        var plant = AssetResources.PLANT_LOGS.rules().validate(fm, new AssetResources.PlantLogFields(TODAY, new BigDecimal("100"), new BigDecimal("142.5"), new BigDecimal("999"), null, null, null,
            null, null, null, null, null, null, null, null), null);
        assertEquals(new BigDecimal("42.5"), plant.bhKl(), "the difference, not what was typed");
        assertEquals("meter-backwards", assertThrows(DomainException.RuleViolated.class, () -> AssetResources.PLANT_LOGS.rules().validate(fm, new AssetResources.PlantLogFields(TODAY,
            new BigDecimal("100"), new BigDecimal("90"), null, null, null, null, null, null, null, null, null, null, null, null), null)).code());
        var dg = AssetResources.DG_FUEL.rules().validate(fm, new AssetResources.DgFuelFields(TODAY, "DG 1", new BigDecimal("1520"), null, new BigDecimal("120"), new BigDecimal("94.5"), new BigDecimal("1"), null, null, null, null, null), null);
        assertEquals(new BigDecimal("11340.00"), dg.amount());
        var bill = AssetResources.ELECTRICITY_BILLS.rules().validate(fm, new AssetResources.ElectricityBillFields("Clubhouse", "C-1", "2026-09", TODAY.minusDays(5), TODAY.plusDays(10),
            new BigDecimal("1200"), null, null, null, null, null, null, null, null, new BigDecimal("10000"), "Unpaid", TODAY, "HDFC", "x", null, null), null);
        assertEquals(new BigDecimal("8.33"), bill.costPerUnit()); assertNull(bill.paidOn(), "not paid: no paid date");
        assertEquals("paid-on-required", assertThrows(DomainException.RuleViolated.class, () -> AssetResources.ELECTRICITY_BILLS.rules().validate(fm, new AssetResources.ElectricityBillFields(
            "Clubhouse", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "Paid", null, null, null, null, null), null)).code());
        var audit = AssetResources.AUDITS.rules().validate(fm, new AssetResources.AuditFields("Pool", TODAY, "Aqua Labs", null, "Pass", new BigDecimal("92"), null, null, null, new BigDecimal("6"),
            TODAY.plusYears(5), null, null), null);
        assertEquals(TODAY.plusMonths(6), audit.nextDue()); assertEquals("Internal", audit.visibility());
        assertEquals("FALSE", AssetResources.EQUIPMENT.rules().readScope(Fixtures.owner(Fixtures.UNIT_A)).sql(), "residents do not see the asset registers");
        assertTrue(AssetResources.AUDITS.rules().readScope(Fixtures.owner(Fixtures.UNIT_A)).params().containsValue("Published"), "but read published audits");
        var pump = new AssetResources.EquipmentFields("STP pump A", "STP", "Pump", null, null, null, 2, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1,
            null, null, null, null, null, null, null, null);
        var renamed = new AssetResources.EquipmentFields("STP pump 1", "STP", "Pump", null, null, null, 2, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1,
            null, null, null, null, null, null, null, null);
        assertEquals("name-fixed", assertThrows(DomainException.RuleViolated.class, () -> AssetResources.EQUIPMENT.rules().validate(fm, renamed, pump)).code());
        assertEquals("STP pump 1", AssetResources.EQUIPMENT.rules().validate(Fixtures.superAdmin(), renamed, pump).name());
        assertTrue(AssetResources.PLANT_LOGS.rules().mayWrite(reader())); assertFalse(AssetResources.INVENTORY.rules().mayWrite(reader()), "stock is the coordinators'");
        assertFalse(AssetResources.CONDITION_LOG.rules().mayWrite(fm), "the condition log is written through the service");
        assertFalse(AssetResources.MAP_VERSIONS.rules().deletable(null));
    }

    @Test void stockAndCondition() {
        Store store = new Store(); Fixtures.Outbox outbox = new Fixtures.Outbox();
        AssetService svc = new AssetService(store, Fixtures.events(List.of(), outbox), new Fixtures.Audit(), Tx.direct(), Fixtures.CLOCK);
        UUID salt = store.item("Salt", "Kg", "0", "20");
        assertThrows(AccessDenied.class, () -> svc.move(reader(), salt, "Received", BigDecimal.TEN, null, null, null, null));
        var in = svc.move(fm(), salt, "Received", new BigDecimal("50"), null, null, "Tata", null);
        assertEquals(0, new BigDecimal("50").compareTo(in.item().quantity())); assertEquals(TODAY, in.item().lastRestocked());
        assertEquals("not-enough", assertThrows(DomainException.RuleViolated.class, () -> svc.move(fm(), salt, "Issued", new BigDecimal("60"), null, null, null, null)).code());
        svc.move(fm(), salt, "Issued", new BigDecimal("25.5"), null, null, null, "STP softener");
        assertTrue(outbox.events.isEmpty(), "24.5 is still above the minimum");
        var low = svc.move(fm(), salt, "Issued", new BigDecimal("5"), null, null, null, null);
        assertEquals(0, new BigDecimal("19.5").compareTo(low.item().quantity()));
        assertEquals("assets.stock.low", outbox.events.get(0).topic());
        assertEquals(Set.of("facility_manager", "handyman_mep"), Recipes.of(outbox.events.get(0), null).get(0).to().roles());
        svc.move(fm(), salt, "Issued", BigDecimal.ONE, null, null, null, null);
        assertEquals(1, outbox.events.size(), "told once when it falls to the minimum, not on every issue");
        var counted = svc.move(fm(), salt, "Counted", new BigDecimal("17"), null, null, null, "Stock take");
        assertEquals(0, new BigDecimal("17").compareTo(counted.movement().balance()));
        assertEquals("bad-quantity", assertThrows(DomainException.RuleViolated.class, () -> svc.move(fm(), salt, "Issued", BigDecimal.ZERO, null, null, null, null)).code());
        assertEquals("future", assertThrows(DomainException.RuleViolated.class, () -> svc.move(fm(), salt, "Received", BigDecimal.ONE, TODAY.plusDays(1), null, null, null)).code());
        assertEquals(5, store.moves.size());

        UUID pump = UUID.randomUUID(); store.assets.put(pump, new AssetStore.Asset(pump, "STP pump A", "Working", TODAY.minusDays(10)));
        svc.condition(reader(), pump, TODAY, "Needs attention", "Inspection", "Noisy bearing", null);
        assertEquals("Needs attention", store.assets.get(pump).status()); assertEquals(TODAY, store.assets.get(pump).lastInspected());
        svc.condition(reader(), pump, TODAY.minusDays(30), "Working", "Inspection", "old note", null);
        assertEquals("Needs attention", store.assets.get(pump).status(), "an older entry does not move the condition back");
        assertEquals("bad-condition", assertThrows(DomainException.RuleViolated.class, () -> svc.condition(reader(), pump, null, "Broken-ish", null, null, null)).code());
        assertFalse(AssetPolicy.writer(Fixtures.helpdesk()));
    }

    static final class Store implements AssetStore {
        final Map<UUID, Stock> items = new LinkedHashMap<>(); final List<Movement> moves = new ArrayList<>(); final Map<UUID, Asset> assets = new LinkedHashMap<>();
        UUID item(String name, String uom, String qty, String min) { UUID id = UUID.randomUUID(); items.put(id, new Stock(id, "INV-1", name, uom, new BigDecimal(qty), new BigDecimal(min), null, 1)); return id; }
        @Override public Optional<Stock> stock(UUID itemId, boolean lock) { return Optional.ofNullable(items.get(itemId)); }
        @Override public Movement move(Stock s, String kind, BigDecimal q, BigDecimal balance, LocalDate on, UUID ticketId, String vendor, String note) {
            Movement m = new Movement(UUID.randomUUID(), "STK-" + (moves.size() + 1), s.id(), kind, q, balance, on, ticketId, vendor, note, null, null, null);
            moves.add(m);
            items.put(s.id(), new Stock(s.id(), s.shortId(), s.item(), s.uom(), balance, s.minStock(), "Received".equals(kind) ? on : s.lastRestocked(), s.version() + 1));
            return m;
        }
        @Override public List<Movement> movements(UUID itemId) { return moves; }
        @Override public Optional<Asset> asset(UUID id, boolean lock) { return Optional.ofNullable(assets.get(id)); }
        @Override public ConditionEntry recordCondition(Asset a, LocalDate date, String condition, String source, String note, UUID ticketId, boolean latest) {
            if (latest) assets.put(a.id(), new Asset(a.id(), a.name(), condition, date));
            return new ConditionEntry(UUID.randomUUID(), "ILG-1", a.id(), a.name(), date, condition, source, note, ticketId, null, null);
        }
        @Override public boolean ticketExists(UUID ticketId) { return true; }
    }
}
