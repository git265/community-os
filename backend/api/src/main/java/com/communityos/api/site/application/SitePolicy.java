package com.communityos.api.site.application;

import com.communityos.api.gate.application.GatePolicy;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;

/** Who does what with the site's devices. The gate's own roles decide: the device layer is the gate's, with more hands. */
final class SitePolicy {
    private SitePolicy() {}
    /** The device list, the ledger, who is on which device: the security team, the facility manager, the committee. */
    static void views(Caller c) { if (!GatePolicy.oversees(c)) throw new AccessDenied("Only the security team, the facility manager and the committee see the site devices"); }
    /** Bridges and devices: a security supervisor, the facility manager, the committee (not a guard, not a bridge). */
    static void manages(Caller c) {
        if (c.category() == Caller.Category.System || !GatePolicy.setsPatrols(c)) throw new AccessDenied("Only a security supervisor, the facility manager or the committee set up devices");
    }
    /** Face consent and card numbers: whoever enrols people at the gate, the facility manager, the committee. */
    static void records(Caller c) { if (!GatePolicy.gateOrFm(c) && !c.isCommittee()) throw new AccessDenied("Only the security team, the facility manager or the committee record face consent"); }
    /** Opening a door from the screen: the gate desk. */
    static void door(Caller c) { if (!GatePolicy.gateStaff(c)) throw new AccessDenied("Only the security team opens a door from the screen"); }
    /** The bridge's own calls: only as a signed-in bridge. */
    static void bridge(Caller c) { if (c.category() != Caller.Category.System || !c.has(Permission.MANAGE_SECURITY)) throw new AccessDenied("Only a site bridge does this"); }
}
