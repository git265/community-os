package com.communityos.api.maintenance.application;

import com.communityos.api.maintenance.application.port.PlannedWorkStore;
import com.communityos.api.maintenance.domain.Planned;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * Planned works reminders (the checklists and their rounds are registers of the resource kit, MaintenanceResources). Once a day is enough;
 * each reminder goes once per checklist and period: on the day a round is due (to its team or person), and once it is past that day and not
 * done (to them and the facility manager) - also for the period that just ended, so a weekly round due on Sunday is told about on Monday.
 */
public final class PlannedWorksService {
    private final PlannedWorkStore store; private final DomainEvents events; private final Tx tx; private final Clock clock;
    public PlannedWorksService(PlannedWorkStore store, DomainEvents events, Tx tx, Clock clock) { this.store = store; this.events = events; this.tx = tx; this.clock = clock; }

    public int remind(Caller system) {
        if (system.category() != Caller.Category.System) throw new AccessDenied("The server's job only");
        return tx.inTx(() -> {
            LocalDate today = LocalDate.now(clock);
            List<DomainEvent> out = new ArrayList<>();
            for (PlannedWorkStore.Active c : store.active()) {
                if (!Planned.FREQUENCIES.contains(c.frequency()) || (c.startsOn() != null && c.startsOn().isAfter(today))) continue;
                Planned.Period p = Planned.of(c.frequency(), c.dueDay(), c.dueMonth(), today);
                boolean counts = c.startsOn() == null || !p.dueOn().isBefore(c.startsOn());   // a checklist started after this period's day begins next period
                if (counts && !store.done(c.id(), p.key())) {
                    if (today.equals(p.dueOn()) && store.claim(c.id(), p.key(), "due")) out.add(event(system, c, p, "due"));
                    else if (today.isAfter(p.dueOn()) && store.claim(c.id(), p.key(), "overdue")) out.add(event(system, c, p, "overdue"));
                }
                Planned.Period prev = Planned.of(c.frequency(), c.dueDay(), c.dueMonth(), p.start().minusDays(1));
                boolean prevCounts = c.startsOn() == null || !prev.dueOn().isBefore(c.startsOn());
                if (prevCounts && !store.done(c.id(), prev.key()) && store.claim(c.id(), prev.key(), "overdue")) out.add(event(system, c, prev, "overdue"));
            }
            events.publish(out);
            return out.size();
        });
    }
    private DomainEvent event(Caller system, PlannedWorkStore.Active c, Planned.Period p, String kind) {
        return new Planned.RoundDue(c.id(), system.community(), c.name(), c.area(), p.key(), p.dueOn(), kind, c.assigneeRole(), c.assigneeId(), clock.instant());
    }
}
