package com.communityos.api.property;

import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.List;
import java.util.UUID;

/** The community's facilities and locations (clubhouse, pools, courts, STP, gates ...): every place a booking, bill, asset or task names. */
public final class PropertyResources {
    private PropertyResources() {}
    /** The kinds offered first; a community may add its own (a pump room, an HT yard), so any short name is kept. */
    public static final List<String> FACILITY_KINDS = List.of("Clubhouse", "Swimming pool", "Gym", "Sports court", "Park / garden", "Parking", "STP", "WTP",
        "Borewell / pumps", "DG room", "Gate / security", "Common area", "Street lights", "Other");
    /** Who sets up the community's places: the unit managers (as for blocks), not block-limited staff. */
    static boolean layout(Caller c) { return c.isSuperAdmin() || (c.has(Permission.MANAGE_UNITS) && !c.isResident() && !c.isBlockLimited()); }

    public record FacilityFields(String name, String kind, UUID blockId, Boolean active, String notes) {}
    public static final Resource<FacilityFields> FACILITIES = new Resource<>(
        new ResourceTable<>("facilities", "property/facilities", "property.facility", FacilityFields.class, "lower(r.name)")
            .computed("blockName", Kind.TEXT, "(SELECT b.name FROM property.block b WHERE b.community_id = r.community_id AND b.id = r.block_id)"),
        new ResourceRules<>() {
            @Override public Spec<FacilityFields> readScope(Caller c) { return Spec.all(); }   // everyone picks a place (a booking, a ticket)
            @Override public boolean mayWrite(Caller c) { return layout(c); }
            @Override public FacilityFields validate(Caller c, FacilityFields f, FacilityFields old) {
                return new FacilityFields(Checks.text(Checks.required(f.name(), "Name"), "Name", 120), kind(f.kind()), f.blockId(),
                    f.active() == null ? Boolean.TRUE : f.active(), Checks.text(f.notes(), "Notes", 2000));
            }
            @Override public String label(FacilityFields f) { return f.name(); }
        });

    /** A listed kind keeps the list's spelling ("stp" is "STP"); another short name is kept as typed. */
    static String kind(String v) {
        String k = Checks.text(Checks.required(v, "Kind"), "Kind", 60).strip();
        String listed = com.communityos.api.shared.domain.Names.pick(FACILITY_KINDS, k);
        return listed != null ? listed : k;
    }

    public static List<Resource<?>> all() { return List.of(FACILITIES); }
}
