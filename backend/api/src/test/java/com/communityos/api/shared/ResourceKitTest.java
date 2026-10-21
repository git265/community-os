package com.communityos.api.shared;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRepository;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceService;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The resource kit: the SQL a table description produces, and the service's order of checks (write right, row right, rules, version). */
class ResourceKitTest {
    public record Thing(String name, Integer order, BigDecimal price, List<String> tags, List<UUID> unitIds, LocalTime opens, boolean active, Map<String, Object> specs) {}
    static final ResourceTable<Thing> TABLE = new ResourceTable<>("things", "test/things", "test.thing", Thing.class, "r.name", Map.of("order", "order_value"))
        .who("addedBy").server("status", ResourceTable.Kind.TEXT, "'New'").filterBy("name");

    @Test void sqlFromTheRecord() {
        assertEquals(List.of("name", "order_value", "price", "tags", "unit_ids", "opens", "active", "specs"), TABLE.columns().stream().map(ResourceTable.Column::column).toList());
        String ins = TABLE.insertSql();
        assertTrue(ins.contains("(community_id, name, order_value, price, tags, unit_ids, opens, active, specs, added_by_id, status)"), ins);
        assertTrue(ins.contains("CAST(:tags AS text[])") && ins.contains("CAST(:unitIds AS uuid[])") && ins.contains("CAST(:opens AS time)") && ins.contains("CAST(:specs AS jsonb)"), ins);
        assertTrue(ins.contains("platform.current_actor(), 'New')"), "server columns are set by the server, never from the body: " + ins);
        String upd = TABLE.updateSql();
        assertFalse(upd.contains("added_by_id") || upd.contains("status ="), "an update never touches server columns: " + upd);
        assertTrue(upd.endsWith("WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version"));
        String sel = TABLE.selectSql("r.active", TABLE.filterSql(List.of("name")));
        assertTrue(sel.contains("WHERE (r.active) AND r.name = CAST(:f_name AS text)"), sel);
        assertTrue(sel.contains("to_char(r.opens, 'HH24:MI') AS opens") && sel.contains("r.specs::text AS specs"), sel);
        assertTrue(sel.contains("(SELECT m.display_name FROM identity.membership m WHERE m.id = r.added_by_id) AS sv_added_by"), sel);
        assertThrows(IllegalArgumentException.class, () -> TABLE.filterBy("nope"));
    }

    // ---- the service, on an in-memory repository ---------------------------------------------------------------------------------------------
    static final class Memory implements ResourceRepository<Thing> {
        final Map<UUID, Item<Thing>> rows = new LinkedHashMap<>();
        public List<Item<Thing>> list(Spec<Thing> scope) { return rows.values().stream().filter((i) -> scope.matches(i.data())).toList(); }
        public Optional<Item<Thing>> get(UUID id, Spec<Thing> scope) { return Optional.ofNullable(rows.get(id)).filter((i) -> scope.matches(i.data())); }
        public UUID insert(Thing f) { UUID id = UUID.randomUUID(); rows.put(id, new Item<>(id, "T-" + rows.size(), 1, Instant.EPOCH, Instant.EPOCH, f, Map.of("addedById", "m-1"))); return id; }
        public long update(UUID id, long v, Thing f) { Item<Thing> o = rows.get(id); if (o.version() != v) return -1; rows.put(id, new Item<>(id, o.shortId(), v + 1, o.createdAt(), Instant.EPOCH, f, o.server())); return v + 1; }
        public boolean delete(UUID id, long v) { return rows.get(id).version() == v && rows.remove(id) != null; }
    }
    final List<String> audit = new ArrayList<>();
    final ResourceRules<Thing> rules = new ResourceRules<>() {
        @Override public Spec<Thing> readScope(Caller c) { return c.isResident() ? new Spec<>("r.active", Map.of(), Thing::active) : Spec.all(); }
        @Override public boolean mayWrite(Caller c) { return c.has(Permission.MANAGE_AMENITIES) || c.isResident(); }
        @Override public Thing validate(Caller c, Thing f, Thing old) {
            if (f.name() == null) throw new DomainException.RuleViolated("required", "Name is required");
            return new Thing(f.name().strip(), f.order(), f.price(), f.tags() == null ? List.of() : f.tags(), f.unitIds(), f.opens(), f.active(), f.specs());
        }
        @Override public boolean mayChange(Caller c, Item<Thing> it) { return !c.isResident() || ResourceRules.mine(c, it, "addedById"); }
        @Override public boolean deletable(Thing f) { return !f.active(); }
    };
    final Resource<Thing> res = new Resource<>(TABLE, rules);
    final ResourceService svc = new ResourceService(Fixtures.events(List.of(), new Fixtures.Outbox()), new Fixtures.Audit(), Tx.direct(), Clock.fixed(Instant.EPOCH, ZoneOffset.UTC));
    final Caller manager = Fixtures.caller(Caller.Category.Staff, java.util.Set.of("facility_manager"), java.util.Set.of(), java.util.Set.of(), Permission.MANAGE_AMENITIES);
    final Caller clerk = Fixtures.utilityClerk();
    final Caller resident = Fixtures.owner(Fixtures.UNIT_A);

    @Test void theServiceChecksInOrder() {
        Memory repo = new Memory();
        assertThrows(AccessDenied.class, () -> svc.create(clerk, res, repo, new Thing("x", 1, null, null, null, null, true, null)), "no write right");
        assertThrows(DomainException.RuleViolated.class, () -> svc.create(manager, res, repo, new Thing(null, 1, null, null, null, null, true, null)), "rules first");
        Item<Thing> a = svc.create(manager, res, repo, new Thing("  Pool ", 1, BigDecimal.ONE, null, null, null, true, null));
        assertEquals("Pool", a.data().name()); assertEquals(List.of(), a.data().tags(), "normalised by the rules");
        Item<Thing> hidden = svc.create(manager, res, repo, new Thing("Store", 2, null, null, null, null, false, null));
        assertEquals(2, svc.list(manager, res, repo).size()); assertEquals(1, svc.list(resident, res, repo).size(), "read scope applies");
        assertThrows(AccessDenied.NotVisible.class, () -> svc.get(resident, res, repo, hidden.id()));
        assertThrows(AccessDenied.class, () -> svc.replace(resident, res, repo, a.id(), a.version(), a.data()), "not the resident's row");
        assertThrows(DomainException.Conflict.class, () -> svc.replace(manager, res, repo, a.id(), a.version() + 5, a.data()), "stale version");
        Item<Thing> b = svc.replace(manager, res, repo, a.id(), a.version(), new Thing("Pool", 3, BigDecimal.TEN, List.of("water"), null, null, true, null));
        assertEquals(2, b.version()); assertEquals(3, (int) b.data().order());
        assertThrows(DomainException.RuleViolated.class, () -> svc.delete(manager, res, repo, b.id(), b.version()), "in use: archive instead");
        svc.delete(manager, res, repo, hidden.id(), hidden.version());
        assertEquals(1, repo.rows.size());
    }
}
