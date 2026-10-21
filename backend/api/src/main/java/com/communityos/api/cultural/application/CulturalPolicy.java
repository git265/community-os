package com.communityos.api.cultural.application;

import com.communityos.api.cultural.domain.Cultural;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.Map;

/** Who runs events, sees money, and which events and donations a caller reads. */
public final class CulturalPolicy {
    private CulturalPolicy() {}
    /** Runs events: the cultural committee (MANAGE_CULTURAL) and the super admin. Records donations received. */
    public static boolean manager(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_CULTURAL); }
    /** Sees all donations and the expenses: the managers, the accounts and the committee. */
    public static boolean finance(Caller c) { return manager(c) || c.has(Permission.MANAGE_LEDGER) || c.isCommittee(); }
    public static boolean member(Caller c) { return c.membership() != null && c.category() != Caller.Category.Vendor && c.category() != Caller.Category.System; }
    /** Events a caller reads (alias given): residents only published ones; staff and the committee all. */
    public static <T> Spec<T> events(Caller c, String alias) {
        if (!member(c)) return Spec.none();
        if (!c.isResident()) return Spec.all();
        return new Spec<>(alias + ".visibility = 'Published'", Map.of(), (x) -> true);
    }
    /** Rows of an event (programme, seva, offerings, brochure, photos): those of events the caller reads. */
    public static <T> Spec<T> ofEvents(Caller c, String eventColumn) {
        if (!member(c)) return Spec.none();
        if (!c.isResident()) return Spec.all();
        return new Spec<>("EXISTS (SELECT 1 FROM cultural.event e WHERE e.community_id = r.community_id AND e.id = " + eventColumn + " AND e.visibility = 'Published')", Map.of(), (x) -> true);
    }
    /** Donations (alias d): the finance side all; a resident their own units'. */
    public static Spec<Cultural.Donation> donations(Caller c) {
        if (finance(c)) return Spec.all();
        if (!c.isResident() || c.units().isEmpty()) return Spec.none();
        return Spec.in("d.unit_id", c.units().stream().map((u) -> u.value()).toList(), (d) -> d.unitId != null && c.units().stream().anyMatch((u) -> u.value().equals(d.unitId)));
    }
}
