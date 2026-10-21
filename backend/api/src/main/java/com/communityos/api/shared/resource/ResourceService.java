package com.communityos.api.shared.resource;

import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Use cases shared by every simple resource (reference lists, settings, registers): list / get / create / replace / delete, each through the
 * resource's own rules, with optimistic versions, an audit line and an outbox event ("amenity.amenity-type.updated").
 */
public final class ResourceService {
    public record Changed(String topic, UUID aggregateId, CommunityId communityId, String collection, Instant occurredAt) implements DomainEvent {}

    private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public ResourceService(DomainEvents events, AuditWriter audit, Tx tx, Clock clock) { this.events = events; this.audit = audit; this.tx = tx; this.clock = clock; }

    public <F extends Record> List<Item<F>> list(Caller c, Resource<F> r, ResourceRepository<F> repo) { return repo.list(r.rules().readScope(c)); }
    public <F extends Record> List<Item<F>> list(Caller c, Resource<F> r, ResourceRepository<F> repo, java.util.Map<String, String> filters) { return repo.list(r.rules().readScope(c), filters); }
    public <F extends Record> Item<F> get(Caller c, Resource<F> r, ResourceRepository<F> repo, UUID id) {
        return repo.get(id, r.rules().readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
    }

    public <F extends Record> Item<F> create(Caller c, Resource<F> r, ResourceRepository<F> repo, F incoming) {
        if (!r.rules().mayWrite(c)) throw new AccessDenied("You cannot change " + human(r));
        F f = r.rules().validate(c, incoming, null);
        return tx.inTx(() -> {
            UUID id = repo.insert(f);
            Item<F> out = repo.get(id, r.rules().readScope(c)).orElseThrow();
            done(c, r, out, AuditWriter.Action.Create, "created");
            return out;
        });
    }

    public <F extends Record> Item<F> replace(Caller c, Resource<F> r, ResourceRepository<F> repo, UUID id, long version, F incoming) {
        if (!r.rules().mayWrite(c)) throw new AccessDenied("You cannot change " + human(r));
        return tx.inTx(() -> {
            Item<F> before = repo.get(id, r.rules().readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
            if (!r.rules().mayChange(c, before)) throw new AccessDenied("You cannot change this " + human(r).replaceAll("s$", ""));
            if (before.version() != version) throw new DomainException.Conflict(r.rules().label(before.data()).isBlank() ? "This record" : r.rules().label(before.data()));
            F f = r.rules().validate(c, incoming, before.data());
            if (repo.update(id, version, f) < 0) throw new DomainException.Conflict("This record");
            Item<F> out = repo.get(id, r.rules().readScope(c)).orElseThrow();
            done(c, r, out, AuditWriter.Action.Update, "updated");
            return out;
        });
    }

    public <F extends Record> void delete(Caller c, Resource<F> r, ResourceRepository<F> repo, UUID id, long version) {
        if (!r.rules().mayWrite(c)) throw new AccessDenied("You cannot change " + human(r));
        tx.run(() -> {
            Item<F> before = repo.get(id, r.rules().readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
            if (!r.rules().mayChange(c, before)) throw new AccessDenied("You cannot remove this " + human(r).replaceAll("s$", ""));
            String why = r.rules().whyNotDeletable(before);
            if (why != null) throw new DomainException.RuleViolated("not-deletable", why);
            if (!repo.delete(id, version)) throw new DomainException.Conflict("This record");
            done(c, r, before, AuditWriter.Action.Delete, "deleted");
        });
    }

    private <F extends Record> void done(Caller c, Resource<F> r, Item<F> it, AuditWriter.Action a, String verb) {
        String topic = r.table().table().replace('_', '-') + "." + verb;
        events.publish(List.of(new Changed(topic, it.id(), c.community(), r.table().collection(), clock.instant())));
        String label = r.rules().label(it.data());
        audit.write(c, a, r.table().table(), it.id(), it.shortId(), null, capital(verb) + " " + human(r) + (label.isBlank() ? "" : ": " + label), List.of());
    }
    private static String human(Resource<?> r) { return r.table().collection().replaceAll("([A-Z])", " $1").toLowerCase(); }
    private static String capital(String s) { return Character.toUpperCase(s.charAt(0)) + s.substring(1); }
}
