package com.communityos.api.property.domain;

import com.communityos.api.shared.domain.AggregateRoot;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.UnitId;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** A villa / apartment. Its number and block are set when the community is set up; occupancy, plan and extras change over time. */
public final class Unit extends AggregateRoot {
    public static final List<String> OCCUPANCY = List.of("Owner occupied", "Tenant occupied", "Vacant");
    public static final List<String> PLANS = List.of("Monthly", "Quarterly", "Yearly");

    private final UnitId id; private final String shortId; private String unitNo; private final BlockId block; private final String blockName;
    private String unitType; private String occupancy; private BigDecimal areaSqft; private String maintenancePlan; private BigDecimal sanctionedKw;
    private final String status; private Map<String, Object> custom; private final Instant updatedAt;

    public Unit(UnitId id, String shortId, String unitNo, BlockId block, String blockName, String unitType, String occupancy, BigDecimal areaSqft, String maintenancePlan,
                BigDecimal sanctionedKw, String status, Map<String, Object> custom, Instant updatedAt, long version) {
        this.id = id; this.shortId = shortId; this.unitNo = unitNo; this.block = block; this.blockName = blockName; this.unitType = unitType; this.occupancy = occupancy;
        this.areaSqft = areaSqft; this.maintenancePlan = maintenancePlan; this.sanctionedKw = sanctionedKw; this.status = status; this.custom = Map.copyOf(custom);
        this.updatedAt = updatedAt; this.version = version;
    }

    /** What a unit manager may change. A null field is left as it is. */
    public record Changes(String unitType, String occupancy, BigDecimal areaSqft, String maintenancePlan, BigDecimal sanctionedKw) {}

    public void change(Changes c, Set<String> allowedTypes) {
        if ("Archived".equals(status)) throw new DomainException.RuleViolated("unit-archived", "An archived unit cannot be changed");
        if (c.unitType() != null) {
            String t = com.communityos.api.shared.domain.Names.pick(allowedTypes, c.unitType());
            if (t == null) throw new DomainException.RuleViolated("bad-unit-type", "Unit type must be one of " + allowedTypes);
            unitType = t;
        }
        if (c.occupancy() != null) {
            String o = com.communityos.api.shared.domain.Names.pick(OCCUPANCY, c.occupancy());
            if (o == null) throw new DomainException.RuleViolated("bad-occupancy", "Occupancy must be one of " + OCCUPANCY);
            occupancy = o;
        }
        if (c.areaSqft() != null) {
            if (c.areaSqft().signum() <= 0 || c.areaSqft().compareTo(BigDecimal.valueOf(100_000)) > 0) throw new DomainException.RuleViolated("bad-area", "Area must be between 1 and 100000 sq ft");
            areaSqft = c.areaSqft();
        }
        if (c.maintenancePlan() != null) {
            String m = com.communityos.api.shared.domain.Names.pick(PLANS, c.maintenancePlan());
            if (m == null) throw new DomainException.RuleViolated("bad-plan", "Plan must be one of " + PLANS);
            maintenancePlan = m;
        }
        if (c.sanctionedKw() != null) {
            if (c.sanctionedKw().signum() < 0 || c.sanctionedKw().compareTo(BigDecimal.valueOf(1000)) > 0) throw new DomainException.RuleViolated("bad-load", "Sanctioned load must be 0 to 1000 kW");
            sanctionedKw = c.sanctionedKw();
        }
    }
    /** A new number (already checked against the naming rules by the service). */
    public void rename(String newNo) {
        if ("Archived".equals(status)) throw new DomainException.RuleViolated("unit-archived", "An archived unit cannot be changed");
        unitNo = newNo;
    }
    public void replaceCustom(Map<String, Object> merged) { custom = Map.copyOf(merged); }

    public UnitId id() { return id; } public String shortId() { return shortId; } public String unitNo() { return unitNo; } public BlockId block() { return block; }
    public String blockName() { return blockName; } public String unitType() { return unitType; } public String occupancy() { return occupancy; }
    public BigDecimal areaSqft() { return areaSqft; } public String maintenancePlan() { return maintenancePlan; } public BigDecimal sanctionedKw() { return sanctionedKw; }
    public String status() { return status; } public Map<String, Object> custom() { return custom; } public Instant updatedAt() { return updatedAt; }
}
