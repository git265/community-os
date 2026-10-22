package com.communityos.api.property.application.port;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** The community's layout: blocks, the naming pattern for unit numbers, and adding units (property.block, property.unit_setting, property.unit). */
public interface PropertySetup {
    record Block(UUID id, String shortId, String name, String code, String kind, int sortOrder, String unitPattern, java.util.Map<String, Object> custom, long units, long version) {
        /** What {block} stands for in a naming pattern. */
        public String token() { return code != null && !code.isBlank() ? code : name; }
    }
    /** `custom`: the app's own extras (planned units, active, notes), kept as given. */
    record BlockFields(String name, String code, String kind, Integer sortOrder, String unitPattern, java.util.Map<String, Object> custom) {
        public BlockFields(String name, String code, String kind, Integer sortOrder, String unitPattern) { this(name, code, kind, sortOrder, unitPattern, null); }
    }
    record NewUnit(String unitNo, UUID blockId, String unitType, String occupancy, BigDecimal areaSqft) {}
    record Added(UUID id, String shortId, String unitNo) {}
    record Setting(String unitPattern, long version) {}

    List<Block> blocks();
    Optional<Block> block(UUID id);
    UUID insertBlock(BlockFields f);
    boolean updateBlock(UUID id, long version, BlockFields f);
    /** false when the version moved or the block still has units. */
    boolean deleteBlock(UUID id, long version);

    Setting setting();
    /** false when the version moved (0 = there is none yet). */
    boolean saveSetting(String unitPattern, long version);

    /** The lower-case numbers of every unit in the community (to find the ones already there). */
    java.util.Set<String> unitKeys();
    /** Is the number (any case) another unit's? */
    boolean numberTaken(String unitNo, UUID except);
    List<Added> insertUnits(List<NewUnit> units);

    /** One home in the community directory: the unit and who to call there (its primary owner, else an owner, else the tenant). */
    record DirectoryEntry(UUID unitId, String unitNo, String blockName, String unitType, String name, String phone, String relation) {}
    /** Every active unit, by number; `q` matches the unit number or the name, `type` the unit type. */
    /** `q`: a unit number, or a contact's name or phone; `block`: one block's homes. */
    com.communityos.api.shared.web.Page<DirectoryEntry> directory(String q, String type, java.util.UUID block, int limit, int offset);
}
