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
        FieldLimits.check(f);
        return tx.inTx(() -> {
            r.rules().verify(c, f, null, repo::exists);
            UUID id = repo.insert(f);
            Item<F> out = repo.get(id, r.rules().readScope(c)).orElseThrow();
            done(c, r, out, AuditWriter.Action.Create, "created", List.of());
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
            FieldLimits.check(f);
            r.rules().verify(c, f, before.data(), repo::exists);
            if (repo.update(id, version, f) < 0) throw new DomainException.Conflict("This record");
            Item<F> out = repo.get(id, r.rules().readScope(c)).orElseThrow();
            done(c, r, out, AuditWriter.Action.Update, "updated", changes(before.data(), out.data()));
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
            done(c, r, before, AuditWriter.Action.Delete, "deleted", List.of());
        });
    }

    /** What an update changed, field by field (long values shortened: the audit shows that it changed, not a copy of a document). */
    static <F extends Record> List<AuditWriter.Change> changes(F before, F after) {
        List<AuditWriter.Change> out = new java.util.ArrayList<>();
        for (var comp : before.getClass().getRecordComponents()) {
            try {
                Object a = comp.getAccessor().invoke(before), b = comp.getAccessor().invoke(after);
                if (java.util.Objects.equals(a instanceof java.math.BigDecimal x ? x.stripTrailingZeros() : a, b instanceof java.math.BigDecimal y ? y.stripTrailingZeros() : b)) continue;
                out.add(new AuditWriter.Change(comp.getName(), shorten(a), shorten(b)));
            } catch (ReflectiveOperationException e) { /* a field the audit cannot read is left out */ }
            if (out.size() >= 40) break;
        }
        return out;
    }
    private static String shorten(Object v) { if (v == null) return null; String s = v.toString(); return s.length() > 200 ? s.substring(0, 197) + "..." : s; }
    private <F extends Record> void done(Caller c, Resource<F> r, Item<F> it, AuditWriter.Action a, String verb, List<AuditWriter.Change> changes) {
        String topic = r.table().table().replace('_', '-') + "." + verb;
        events.publish(List.of(new Changed(topic, it.id(), c.community(), r.table().collection(), clock.instant())));
        String label = r.rules().label(it.data());
        audit.write(c, a, r.table().table(), it.id(), it.shortId(), null, capital(verb) + " " + human(r) + (label.isBlank() ? "" : ": " + label), changes);
    }
    private static String human(Resource<?> r) { return r.table().collection().replaceAll("([A-Z])", " $1").toLowerCase(); }
    private static String capital(String s) { return Character.toUpperCase(s.charAt(0)) + s.substring(1); }
}
