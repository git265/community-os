package com.communityos.api.cultural.application;

import com.communityos.api.cultural.application.port.CulturalStore;
import com.communityos.api.cultural.domain.Cultural;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Sign-up lists on seva slots (one entry = one volunteer) and programme items (with an expected head count, a household says how many come).
 * People sign up and withdraw as themselves, while there is room; the committee removes anyone. The list is locked while it changes, so two
 * people never take the last place.
 */
public final class SignupService {
    private final CulturalStore store; private final AuditWriter audit; private final Tx tx;
    public SignupService(CulturalStore store, AuditWriter audit, Tx tx) { this.store = store; this.audit = audit; this.tx = tx; }

    public CulturalStore.Slot signUp(Caller c, CulturalStore.List_ which, UUID id, Integer people) {
        if (!CulturalPolicy.member(c)) throw new AccessDenied("Sign in to sign up");
        return tx.inTx(() -> {
            CulturalStore.Slot s = slot(c, which, id);
            UUID me = c.membership().value();
            if (s.list().stream().anyMatch((x) -> me.equals(x.membershipId()))) return s;
            int n = which == CulturalStore.List_.PROGRAM && s.peoplePerUnit() > 0 ? (people == null ? s.peoplePerUnit() : people) : 1;
            if (n < 1 || n > 50) throw new DomainException.RuleViolated("bad-people", "Between 1 and 50 people");
            int used = which == CulturalStore.List_.PROGRAM && s.peoplePerUnit() > 0 ? Cultural.headcount(s.list()) : s.list().size();
            if (s.limit() > 0 && used + n > s.limit()) throw new DomainException.RuleViolated("full", s.title() + " is full");
            List<Cultural.Signup> next = new ArrayList<>(s.list());
            String unit = c.units().isEmpty() ? null : store.unitNo(c.units().iterator().next().value());
            next.add(new Cultural.Signup(me, c.displayName(), unit, which == CulturalStore.List_.PROGRAM && s.peoplePerUnit() > 0 ? n : null));
            store.saveList(which, id, next);
            audit.write(c, AuditWriter.Action.Update, which == CulturalStore.List_.SEVA ? "cultural.seva" : "cultural.program", id, null, null, "Signed up for " + s.title(), List.of());
            return store.slot(which, id, false).orElseThrow();
        });
    }
    /** Withdraw myself, or (the committee) remove someone. */
    public CulturalStore.Slot withdraw(Caller c, CulturalStore.List_ which, UUID id, UUID membershipId) {
        if (!CulturalPolicy.member(c)) throw new AccessDenied("Sign in first");
        UUID who = membershipId == null ? c.membership().value() : membershipId;
        if (!who.equals(c.membership().value()) && !CulturalPolicy.manager(c)) throw new AccessDenied("Only the committee removes someone else");
        return tx.inTx(() -> {
            CulturalStore.Slot s = slot(c, which, id);
            List<Cultural.Signup> next = s.list().stream().filter((x) -> !who.equals(x.membershipId())).toList();
            if (next.size() == s.list().size()) return s;
            store.saveList(which, id, next);
            audit.write(c, AuditWriter.Action.Update, which == CulturalStore.List_.SEVA ? "cultural.seva" : "cultural.program", id, null, null, "Left " + s.title(), List.of());
            return store.slot(which, id, false).orElseThrow();
        });
    }
    private CulturalStore.Slot slot(Caller c, CulturalStore.List_ which, UUID id) {
        CulturalStore.Slot s = store.slot(which, id, true).orElseThrow(AccessDenied.NotVisible::new);
        Cultural.Event ev = store.event(s.eventId(), false).orElseThrow(AccessDenied.NotVisible::new);
        if (c.isResident() && !ev.published()) throw new AccessDenied.NotVisible();
        if (!List.of("Planning", "Open").contains(ev.status())) throw new DomainException.RuleViolated("event-closed", ev.name() + " is " + ev.status().toLowerCase());
        return s;
    }
}
