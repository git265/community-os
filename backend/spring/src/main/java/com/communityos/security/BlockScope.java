package com.communityos.security;

import com.communityos.domain.ScopeNode;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

/**
 * BLOCK-LIMITED STAFF: a user whose record lists blocks (users.blocks) sees and changes only the units of those blocks (a Block Admin / Block
 * Secretary in a community of several towers). Rows that name no unit stay visible. (withBlockScope / blockWriteOk in authz.js)
 */
public final class BlockScope {
    private BlockScope() {}

    static final Set<String> BLOCK_UNIT_COLLECTIONS = Set.of("dues", "tickets", "amenities", "readings", "villaElectricity", "unitCredits", "gateVisits", "gatePasses",
            "gateApprovals", "gateLinks", "gateVillaRules", "culturalDonations");

    public static List<String> blocksOf(Principal p) { return p == null ? List.of() : p.blocks().stream().filter((b) -> b != null && !b.isEmpty()).toList(); }
    public static boolean limited(Principal p) { return p != null && !Perms.isAdmin(p) && !Perms.isResident(p) && !blocksOf(p).isEmpty(); }

    private static Set<String> unitsInBlocks(Principal p, RawReader raw) {
        Set<String> mine = new LinkedHashSet<>(blocksOf(p));
        Set<String> units = new LinkedHashSet<>();
        for (JsonNode u : raw.read("properties")) { String z = Js.text(u, "zone"); if (z != null && mine.contains(z)) units.add(Js.str(u, "unit")); }
        return units;
    }

    /** May this person write this record, given the blocks they are limited to? (true for everyone not block-limited) */
    public static boolean writeOk(String collection, JsonNode record, JsonNode old, Principal p, RawReader raw) {
        if (!limited(p)) return true;
        if ("properties".equals(collection)) {
            Set<String> mine = new LinkedHashSet<>(blocksOf(p));
            String z = Js.text(record, "zone");
            return z != null && mine.contains(z) && (old == null || (Js.text(old, "zone") != null && mine.contains(Js.text(old, "zone"))));
        }
        if (!BLOCK_UNIT_COLLECTIONS.contains(collection)) return true;
        Set<String> units = unitsInBlocks(p, raw);
        return unitOk(record, units) && unitOk(old, units);
    }
    private static boolean unitOk(JsonNode r, Set<String> units) { return r == null || !Js.truthy(r, "unit") || units.contains(Js.str(r, "unit")); }

    /** Narrows `base` to the person's blocks. The SQL form stays exact only when both halves have one. */
    static RowScope narrow(String collection, Principal p, RawReader raw, RowScope base) {
        if (!limited(p)) return base;
        Predicate<JsonNode> extra; ScopeNode extraSql;
        if ("properties".equals(collection)) {
            Set<String> mine = new LinkedHashSet<>(blocksOf(p));
            extra = (r) -> { String z = Js.text(r, "zone"); return z != null && mine.contains(z); };
            extraSql = new ScopeNode.In("zone", List.copyOf(mine));
        } else if (BLOCK_UNIT_COLLECTIONS.contains(collection)) {
            Set<String> units = unitsInBlocks(p, raw);
            extra = (r) -> !Js.truthy(r, "unit") || units.contains(Js.str(r, "unit"));
            extraSql = new ScopeNode.Or(List.of(new ScopeNode.Empty("unit"), new ScopeNode.In("unit", List.copyOf(units))));
        } else return base;
        Predicate<JsonNode> bp = base.predicate();
        ScopeNode sql = bp == null ? extraSql : base.sql() != null ? new ScopeNode.And(List.of(base.sql(), extraSql)) : null;
        return new RowScope((r) -> extra.test(r) && (bp == null || bp.test(r)), sql, base.transform());
    }
}
