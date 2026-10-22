package com.communityos.api.property.application;

import com.communityos.api.property.application.port.UnitRepository;
import com.communityos.api.property.domain.Unit;
import com.communityos.api.property.domain.UnitNaming;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.custom.CustomFields;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Use cases for units. Reads and writes both go through UnitPolicy; the version guards against lost updates. */
public final class UnitService {
    private final UnitRepository units; private final CustomFields customFields; private final AuditWriter audit; private final Tx tx;
    private final com.communityos.api.property.application.port.PropertySetup setup;
    private final UnitPolicy policy = new UnitPolicy();
    public static final int BATCH_MAX = 3000;
    public static final java.util.List<String> BLOCK_KINDS = java.util.List.of("Block", "Tower", "Phase", "Lane", "Zone");

    public UnitService(UnitRepository units, CustomFields customFields, AuditWriter audit, Tx tx, com.communityos.api.property.application.port.PropertySetup setup) {
        this.units = units; this.customFields = customFields; this.audit = audit; this.tx = tx; this.setup = setup;
    }

    public Page<Unit> list(Caller c, UnitRepository.Filter f, PageQuery page) { return units.find(policy.readScope(c), f, page); }
    /** The directory's block list: each block's homes and how they are lived in (only the units this caller may see are counted). */
    public List<UnitRepository.BlockCount> countByBlock(Caller c) {
        // a resident sees every home in the contact directory, so the blocks' sizes are counted over the whole community for them too
        if (c.membership() != null && c.category() == Caller.Category.Resident) return units.countByBlock(com.communityos.api.shared.access.Spec.all());
        return units.countByBlock(policy.readScope(c));
    }
    /** Every unit's number and block (the units this caller may see), in one answer. */
    public List<UnitRepository.Entry> index(Caller c) { return units.index(policy.readScope(c)); }
    public Unit get(Caller c, UnitId id) { return units.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new); }

    public Unit change(Caller c, UnitId id, long expectedVersion, Unit.Changes changes, Map<String, Object> custom) { return change(c, id, expectedVersion, null, changes, custom); }
    /** `newNo` (may be null): a new number for the unit, checked like a new unit's; bills, tickets and bookings point at the unit, not its number. */
    public Unit change(Caller c, UnitId id, long expectedVersion, String newNo, Unit.Changes changes, Map<String, Object> custom) {
        return tx.inTx(() -> {
            Unit u = units.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
            if (!policy.writeScope(c).matches(u)) throw new AccessDenied("You cannot change this unit");
            if (u.version() != expectedVersion) throw new DomainException.Conflict("Unit " + u.unitNo());
            List<AuditWriter.Change> diff = new ArrayList<>();
            if (newNo != null && !UnitNaming.normalize(newNo).equals(u.unitNo())) {
                var b = u.block() == null ? null : setup.block(u.block().value()).orElse(null);
                String no = UnitNaming.check(newNo, patternFor(b), b == null ? null : b.token());
                if (setup.numberTaken(no, u.id().value())) throw new DomainException.RuleViolated("duplicate-unit", "There is already a unit “" + no + "” (numbers are the same whatever their case)");
                track(diff, "unitNo", u.unitNo(), no); u.rename(no);
            }
            String type = u.unitType(), occ = u.occupancy(), plan = u.maintenancePlan(); Object area = u.areaSqft(), kw = u.sanctionedKw(); Map<String, Object> before = u.custom();
            u.change(changes, units.propertyTypes());
            u.replaceCustom(customFields.apply("property.unit", u.custom(), custom, c.roleIds()));
            track(diff, "unitType", type, u.unitType()); track(diff, "occupancy", occ, u.occupancy()); track(diff, "maintenancePlan", plan, u.maintenancePlan());
            track(diff, "areaSqft", area, u.areaSqft()); track(diff, "sanctionedKw", kw, u.sanctionedKw()); track(diff, "custom", before, u.custom());
            if (diff.isEmpty()) return u;
            if (!units.save(u, expectedVersion)) throw new DomainException.Conflict("Unit " + u.unitNo());
            audit.write(c, AuditWriter.Action.Update, "property.unit", u.id().value(), u.shortId(), u.id().value(), "Updated " + u.unitNo(), diff);
            return units.findById(id, policy.readScope(c)).orElseThrow();
        });
    }

    // ---- the layout: blocks, the naming pattern, new units -----------------------------------------------------------------------------------------
    private void layout(Caller c) {
        if (!c.isSuperAdmin() && (!c.has(com.communityos.api.shared.security.Permission.MANAGE_UNITS) || c.isResident() || c.isBlockLimited()))
            throw new AccessDenied("Only the community's unit managers change its blocks and naming rules");
    }
    /** The pattern a unit in this block follows: the block's own, else the community's (null: only the character rules). */
    private String patternFor(com.communityos.api.property.application.port.PropertySetup.Block b) {
        if (b != null && b.unitPattern() != null && !b.unitPattern().isBlank()) return b.unitPattern();
        return setup.setting().unitPattern();
    }

    public List<com.communityos.api.property.application.port.PropertySetup.Block> blocks(Caller c) {
        if (c.category() == Caller.Category.Vendor) throw new AccessDenied("Not available");
        return setup.blocks();
    }
    public com.communityos.api.property.application.port.PropertySetup.Block saveBlock(Caller c, java.util.UUID id, Long version, com.communityos.api.property.application.port.PropertySetup.BlockFields f) {
        layout(c);
        String name = UnitNaming.normalize(f.name());
        if (name.isEmpty() || name.length() > 80) throw new DomainException.RuleViolated("bad-block", "A block needs a name of up to 80 characters");
        String code = f.code() == null || f.code().isBlank() ? null : f.code().strip();
        if (code != null && !code.matches("[A-Za-z0-9]{1,6}")) throw new DomainException.RuleViolated("bad-block-code", "A block code is 1-6 letters or digits (A, T2, PH1)");
        String kind = f.kind() == null || f.kind().isBlank() ? "Block" : f.kind();
        if (!BLOCK_KINDS.contains(kind)) throw new DomainException.RuleViolated("bad-block-kind", "Kind must be one of " + BLOCK_KINDS);
        String pattern = UnitNaming.checkPattern(f.unitPattern());
        if (f.custom() != null && f.custom().size() > 20) throw new DomainException.RuleViolated("too-many", "Too many extra fields on a block");
        var fields = new com.communityos.api.property.application.port.PropertySetup.BlockFields(name, code, kind, f.sortOrder(), pattern, f.custom());
        return tx.inTx(() -> {
            for (var other : setup.blocks()) {
                if (other.id().equals(id)) continue;
                if (other.name().equalsIgnoreCase(name)) throw new DomainException.RuleViolated("duplicate-block", "There is already a block “" + other.name() + "”");
                if (code != null && code.equalsIgnoreCase(other.code())) throw new DomainException.RuleViolated("duplicate-block-code", "Block “" + other.name() + "” already has the code " + other.code());
            }
            java.util.UUID bid = id;
            if (id == null) {
                bid = setup.insertBlock(fields);
                audit.write(c, AuditWriter.Action.Create, "property.block", bid, null, null, "Added block " + name, List.of());
            } else {
                var before = setup.block(id).orElseThrow(AccessDenied.NotVisible::new);
                if (version == null || !setup.updateBlock(id, version, fields)) throw new DomainException.Conflict("Block " + before.name());
                List<AuditWriter.Change> diff = new ArrayList<>();
                track(diff, "name", before.name(), name); track(diff, "code", before.code(), code); track(diff, "kind", before.kind(), kind); track(diff, "unitPattern", before.unitPattern(), pattern);
                audit.write(c, AuditWriter.Action.Update, "property.block", id, before.shortId(), null, "Changed block " + name, diff);
            }
            return setup.block(bid).orElseThrow();
        });
    }
    public void deleteBlock(Caller c, java.util.UUID id, long version) {
        layout(c);
        tx.inTx(() -> {
            var b = setup.block(id).orElseThrow(AccessDenied.NotVisible::new);
            if (b.units() > 0) throw new DomainException.RuleViolated("block-in-use", b.name() + " still has " + b.units() + " units. Move them to another block first.");
            if (!setup.deleteBlock(id, version)) throw new DomainException.Conflict("Block " + b.name());
            audit.write(c, AuditWriter.Action.Delete, "property.block", id, b.shortId(), null, "Deleted block " + b.name(), List.of());
            return null;
        });
    }
    public com.communityos.api.property.application.port.PropertySetup.Setting naming(Caller c) { return setup.setting(); }
    /**
     * The community's contact directory: every home with who to call there - for every member, residents included (a resident's own
     * unit list shows only their units; the directory is how they reach a neighbour). Vendors and a caller with no membership get none.
     */
    public com.communityos.api.shared.web.Page<com.communityos.api.property.application.port.PropertySetup.DirectoryEntry> directory(Caller c, String q, String type, PageQuery page) { return directory(c, q, type, null, page); }
    public com.communityos.api.shared.web.Page<com.communityos.api.property.application.port.PropertySetup.DirectoryEntry> directory(Caller c, String q, String type, java.util.UUID block, PageQuery page) {
        if (c.membership() == null || c.category() == Caller.Category.Vendor || c.category() == Caller.Category.System) throw new AccessDenied("The directory is for the community's members");
        return setup.directory(q, type, block, page.limit(), page.offset());
    }
    /** The community's pattern for unit numbers. Units already there keep their numbers; new and renamed ones follow it. */
    public com.communityos.api.property.application.port.PropertySetup.Setting setNaming(Caller c, String pattern, long version) {
        layout(c);
        String p = UnitNaming.checkPattern(pattern);
        return tx.inTx(() -> {
            var before = setup.setting();
            if (!setup.saveSetting(p, version)) throw new DomainException.Conflict("The naming pattern");
            List<AuditWriter.Change> diff = new ArrayList<>(); track(diff, "unitPattern", before.unitPattern(), p);
            audit.write(c, AuditWriter.Action.Update, "property.unit_setting", null, null, null, p == null ? "Removed the unit naming pattern" : "Unit naming pattern: " + p, diff);
            return setup.setting();
        });
    }

    public record Batch(List<com.communityos.api.property.application.port.PropertySetup.Added> added, List<String> skipped) {}
    /**
     * New units, one or many (bulk add, import). Every number is checked against the character rules and its block's pattern; a number that is
     * already a unit (any case) is skipped and reported; a number that breaks a rule refuses the whole batch, naming the first problems.
     */
    public Batch add(Caller c, List<com.communityos.api.property.application.port.PropertySetup.NewUnit> rows) {
        if (!c.isSuperAdmin() && (!c.has(com.communityos.api.shared.security.Permission.MANAGE_UNITS) || c.isResident())) throw new AccessDenied("You cannot add units");
        if (rows == null || rows.isEmpty()) throw new DomainException.RuleViolated("no-units", "Nothing to add");
        if (rows.size() > BATCH_MAX) throw new DomainException.RuleViolated("too-many", "At most " + BATCH_MAX + " units at once");
        java.util.Set<String> types = units.propertyTypes();
        return tx.inTx(() -> {
            Map<java.util.UUID, com.communityos.api.property.application.port.PropertySetup.Block> blocks = new java.util.HashMap<>();
            for (var b : setup.blocks()) blocks.put(b.id(), b);
            java.util.Set<String> have = setup.unitKeys();
            List<String> problems = new ArrayList<>(); List<String> skipped = new ArrayList<>();
            List<com.communityos.api.property.application.port.PropertySetup.NewUnit> ok = new ArrayList<>();
            for (var r : rows) {
                var b = r.blockId() == null ? null : blocks.get(r.blockId());
                if (r.blockId() != null && b == null) { problems.add(UnitNaming.normalize(r.unitNo()) + ": unknown block"); continue; }
                if (c.isBlockLimited() && (b == null || c.blocks().stream().noneMatch((x) -> x.value().equals(b.id())))) { problems.add(UnitNaming.normalize(r.unitNo()) + ": outside the blocks you manage"); continue; }
                String why = UnitNaming.problem(r.unitNo(), patternFor(b), b == null ? null : b.token());
                if (why != null) { problems.add(why); continue; }
                String no = UnitNaming.normalize(r.unitNo());
                String type = r.unitType() == null || r.unitType().isBlank() ? types.iterator().next() : com.communityos.api.shared.domain.Names.pick(types, r.unitType());
                if (type == null) { problems.add(no + ": unit type must be one of " + types); continue; }
                String occ = r.occupancy() == null || r.occupancy().isBlank() ? "Vacant" : com.communityos.api.shared.domain.Names.pick(Unit.OCCUPANCY, r.occupancy());
                if (occ == null) { problems.add(no + ": occupancy must be one of " + Unit.OCCUPANCY); continue; }
                if (r.areaSqft() != null && (r.areaSqft().signum() <= 0 || r.areaSqft().compareTo(java.math.BigDecimal.valueOf(100_000)) > 0)) { problems.add(no + ": area must be 1 to 100000 sq ft"); continue; }
                if (!have.add(UnitNaming.key(no))) { skipped.add(no); continue; }        // already a unit, or twice in this batch
                ok.add(new com.communityos.api.property.application.port.PropertySetup.NewUnit(no, r.blockId(), type, occ, r.areaSqft()));
            }
            if (!problems.isEmpty()) throw new DomainException.RuleViolated("bad-unit-number", (problems.size() == 1 ? "" : problems.size() + " problems: ") + String.join("; ", problems.subList(0, Math.min(5, problems.size())))
                + (problems.size() > 5 ? " ..." : ""));
            var added = setup.insertUnits(ok);
            if (!added.isEmpty()) audit.write(c, AuditWriter.Action.Create, "property.unit", added.size() == 1 ? added.get(0).id() : null, added.size() == 1 ? added.get(0).shortId() : null,
                added.size() == 1 ? added.get(0).id() : null, added.size() == 1 ? "Added unit " + added.get(0).unitNo() : "Added " + added.size() + " units (" + added.get(0).unitNo() + " ... " + added.get(added.size() - 1).unitNo() + ")", List.of());
            return new Batch(added, skipped);
        });
    }

    private static void track(List<AuditWriter.Change> diff, String field, Object from, Object to) {
        if (!Objects.equals(from == null ? null : String.valueOf(from), to == null ? null : String.valueOf(to)))
            diff.add(new AuditWriter.Change(field, from == null ? null : String.valueOf(from), to == null ? null : String.valueOf(to)));
    }
}
