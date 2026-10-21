package com.communityos.api.property.application;

import com.communityos.api.property.application.port.UnitRepository;
import com.communityos.api.property.domain.Unit;
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
    private final UnitPolicy policy = new UnitPolicy();

    public UnitService(UnitRepository units, CustomFields customFields, AuditWriter audit, Tx tx) { this.units = units; this.customFields = customFields; this.audit = audit; this.tx = tx; }

    public Page<Unit> list(Caller c, UnitRepository.Filter f, PageQuery page) { return units.find(policy.readScope(c), f, page); }
    public Unit get(Caller c, UnitId id) { return units.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new); }

    public Unit change(Caller c, UnitId id, long expectedVersion, Unit.Changes changes, Map<String, Object> custom) {
        return tx.inTx(() -> {
            Unit u = units.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
            if (!policy.writeScope(c).matches(u)) throw new AccessDenied("You cannot change this unit");
            if (u.version() != expectedVersion) throw new DomainException.Conflict("Unit " + u.unitNo());
            List<AuditWriter.Change> diff = new ArrayList<>();
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

    private static void track(List<AuditWriter.Change> diff, String field, Object from, Object to) {
        if (!Objects.equals(from == null ? null : String.valueOf(from), to == null ? null : String.valueOf(to)))
            diff.add(new AuditWriter.Change(field, from == null ? null : String.valueOf(from), to == null ? null : String.valueOf(to)));
    }
}
