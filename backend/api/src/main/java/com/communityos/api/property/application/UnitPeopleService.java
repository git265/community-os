package com.communityos.api.property.application;

import com.communityos.api.identity.application.port.PersonDirectory;
import com.communityos.api.identity.application.port.RefreshTokenStore;
import com.communityos.api.identity.domain.Phone;
import com.communityos.api.property.application.port.UnitPeople;
import com.communityos.api.property.application.port.UnitPeople.Person;
import com.communityos.api.property.application.port.UnitRepository;
import com.communityos.api.property.domain.Unit;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.CallerLoader;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Who lives in or owns a unit, over time. Three ways it changes:
 *   - save: the unit's contacts as the unit form shows them (owner, tenant, co-owners, family); someone taken off has left today
 *   - moveOut: a tenant (and their family) leaves on a day
 *   - changeOwner: the unit is sold or transferred - the old owners leave, the new owner comes, on a day
 * Nothing is deleted: a person who leaves keeps their row with the day they left, their bills, requests and bookings stay as they were,
 * and the change is written to the unit's history. Someone with no other home here and no other role loses their sign-in; their unit's
 * household staff, passes and cars stop at the gate when the household goes. What stays open (unpaid bills, future bookings, open requests)
 * is reported, not settled: unpaid bills stay with the unit.
 */
public final class UnitPeopleService {
    public static final List<String> RELATIONS = List.of("Owner", "Co-owner", "Tenant", "Family", "Caretaker");
    /** Roles that exist only because someone lives here: a member with no others has nothing left when they leave. */
    static final Set<String> RESIDENT_ROLES = Set.of("owner", "resident");

    public record PersonIn(UUID occupantId, String name, String phone, String email, String relation, Boolean primary) {}
    public record SavePeople(List<PersonIn> people, String occupancy, String billTo) {}
    public record MoveOut(LocalDate on, List<UUID> occupantIds, String occupancyAfter, Boolean endGate, String note) {}
    public record ChangeOwner(LocalDate on, PersonIn newOwner, List<PersonIn> coOwners, List<UUID> leavingIds, String occupancyAfter, Boolean endGate, String note) {}
    /** What a move-out or a change of owner did, and what it left open. */
    public record Outcome(UUID changeId, List<Person> people, UnitPeople.Leftovers leftovers, UnitPeople.GateEnded gate, int accountsClosed) {}

    private final UnitRepository units; private final UnitPeople store; private final PersonDirectory persons; private final RefreshTokenStore tokens;
    private final CallerLoader callers; private final AuditWriter audit; private final Tx tx; private final Clock clock; private final String countryCode;
    private final UnitPolicy policy = new UnitPolicy();

    public UnitPeopleService(UnitRepository units, UnitPeople store, PersonDirectory persons, RefreshTokenStore tokens, CallerLoader callers, AuditWriter audit, Tx tx,
                             Clock clock, String countryCode) {
        this.units = units; this.store = store; this.persons = persons; this.tokens = tokens; this.callers = callers; this.audit = audit; this.tx = tx; this.clock = clock;
        this.countryCode = countryCode;
    }

    // ---- reading -----------------------------------------------------------------------------------------------------------------------------
    /** The unit's people. A resident sees who lives in their own unit now; the unit's managers and the committee also see who lived there before. */
    public List<Person> people(Caller c, UnitId id, boolean history) {
        Unit u = units.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
        if (c.category() == Caller.Category.Vendor || c.category() == Caller.Category.System) throw new AccessDenied("Not available");
        boolean past = history && (manager(c) || c.isCommittee());
        return store.people(u.id().value(), past);
    }
    public List<UnitPeople.Change> history(Caller c, UnitId id) {
        Unit u = units.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
        if (!(manager(c) || c.isCommittee())) throw new AccessDenied("The unit's history is for its managers and the committee");
        return store.changes(u.id().value());
    }

    /** What would stay open if these people left (shown before a move-out or a change of owner): unpaid bills, their bookings and requests. */
    public UnitPeople.Leftovers leftovers(Caller c, UnitId id, List<UUID> occupantIds) {
        Unit u = managed(c, id);
        List<UUID> ids = occupantIds == null ? List.of() : occupantIds;
        List<Person> leaving = store.people(u.id().value(), false).stream().filter((p) -> ids.contains(p.occupantId())).toList();
        return store.leftovers(u.id().value(), members(leaving), LocalDate.now(clock));
    }

    // ---- the unit form: its contacts as a list ------------------------------------------------------------------------------------------------
    public List<Person> save(Caller c, UnitId id, SavePeople cmd) {
        Unit u = managed(c, id);
        LocalDate today = LocalDate.now(clock);
        List<In> want = check(cmd.people() == null ? List.of() : cmd.people());
        String occ = cmd.occupancy() == null || cmd.occupancy().isBlank() ? u.occupancy() : pick(Unit.OCCUPANCY, cmd.occupancy(), "Occupancy");
        String billTo = cmd.billTo() == null || cmd.billTo().isBlank() ? null : pick(List.of("Owner", "Tenant"), cmd.billTo(), "Bills go to");
        consistent(occ, billTo, want.stream().anyMatch((x) -> "Tenant".equals(x.relation)));
        Map<String, UUID> personOf = resolve(want);                                   // the global person rows, before the community's transaction
        return tx.inTx(() -> {
            List<Person> now = store.people(u.id().value(), false);
            Map<UUID, Person> byId = new HashMap<>(); Map<String, Person> byPhone = new HashMap<>();
            for (Person p : now) { byId.put(p.occupantId(), p); if (p.phone() != null) byPhone.put(p.phone(), p); }
            Set<UUID> kept = new HashSet<>(); List<UUID> ended = new ArrayList<>(); List<In> added = new ArrayList<>(); List<Object[]> updates = new ArrayList<>();
            for (In w : want) {
                Person had = w.occupantId != null ? byId.get(w.occupantId) : null;
                if (had == null) had = byPhone.get(w.phone);
                if (had != null && Objects.equals(had.phone(), w.phone)) {
                    kept.add(had.occupantId());
                    if (!Objects.equals(had.name(), w.name) || !Objects.equals(had.email(), w.email) || !Objects.equals(had.relation(), w.relation) || had.primary() != w.primary)
                        updates.add(new Object[] {had.occupantId(), w});
                } else added.add(w);                                                  // a new person, or the same slot with another number: another person
            }
            for (Person p : now) if (!kept.contains(p.occupantId())) ended.add(p.occupantId());
            List<Person> leaving = now.stream().filter((p) -> ended.contains(p.occupantId())).toList();
            store.endOccupants(ended, today);
            for (Object[] x : updates) { In w = (In) x[1]; if (!w.primary) store.updateOccupant((UUID) x[0], w.name, w.email, w.relation, false); }   // a primary owner is set last
            for (Object[] x : updates) { In w = (In) x[1]; if (w.primary) store.updateOccupant((UUID) x[0], w.name, w.email, w.relation, true); }
            for (In w : added) arrive(u, w, personOf.get(w.phone), today);
            int closed = leave(u, leaving);
            if (!Objects.equals(occ, u.occupancy()) || billTo != null) store.setOccupancy(u.id().value(), occ, billTo);
            if (!leaving.isEmpty() || !added.isEmpty()) {
                Map<String, Object> summary = new LinkedHashMap<>(); summary.put("accountsClosed", closed);
                store.recordChange(u.id().value(), "People changed", today, out(leaving), in(added), u.occupancy(), occ, BigDecimal.ZERO, summary, null);
            }
            if (!leaving.isEmpty() || !added.isEmpty() || !updates.isEmpty())
                audit.write(c, AuditWriter.Action.Update, "property.occupant", u.id().value(), u.shortId(), u.id().value(), "People of " + u.unitNo() + " changed"
                    + (added.isEmpty() ? "" : ": " + added.size() + " added") + (leaving.isEmpty() ? "" : ", " + leaving.size() + " left"), List.of());
            return store.people(u.id().value(), false);
        });
    }

    // ---- a tenant (and their family) moves out ---------------------------------------------------------------------------------------------
    public Outcome moveOut(Caller c, UnitId id, MoveOut cmd) {
        Unit u = managed(c, id);
        LocalDate on = day(cmd.on());
        if (cmd.occupantIds() == null || cmd.occupantIds().isEmpty()) throw new DomainException.RuleViolated("nobody-leaving", "Choose who is moving out");
        String occ = pick(Unit.OCCUPANCY, cmd.occupancyAfter(), "Occupied by afterwards");
        String note = note(cmd.note());
        return tx.inTx(() -> {
            List<Person> now = store.people(u.id().value(), false);
            List<Person> leaving = now.stream().filter((p) -> cmd.occupantIds().contains(p.occupantId())).toList();
            if (leaving.size() != new HashSet<>(cmd.occupantIds()).size()) throw new DomainException.RuleViolated("not-living-here", "Someone chosen no longer lives in " + u.unitNo() + " - reload");
            if (leaving.stream().anyMatch(Person::owner)) throw new DomainException.RuleViolated("owner-leaving", "An owner leaves by a change of owner, not a move-out");
            if (leaving.stream().anyMatch((p) -> p.from() != null && p.from().isAfter(on))) throw new DomainException.RuleViolated("before-arrival", "Someone chosen came after that day");
            List<Person> staying = now.stream().filter((p) -> !leaving.contains(p)).toList();
            boolean tenantStays = staying.stream().anyMatch((p) -> "Tenant".equals(p.relation()));
            consistent(occ, null, tenantStays);
            UnitPeople.Leftovers left = store.leftovers(u.id().value(), members(leaving), LocalDate.now(clock));
            store.endOccupants(leaving.stream().map(Person::occupantId).toList(), on);
            int closed = leave(u, leaving);
            UnitPeople.GateEnded gate = !Boolean.FALSE.equals(cmd.endGate()) && !tenantStays ? store.endGateAccess(u.id().value()) : new UnitPeople.GateEnded(0, 0, 0, false);
            store.setOccupancy(u.id().value(), occ, tenantStays ? null : "Owner");
            UUID change = store.recordChange(u.id().value(), "Moved out", on, out(leaving), List.of(), u.occupancy(), occ, left.duesOutstanding(), summary(left, gate, closed), note);
            audit.write(c, AuditWriter.Action.Update, "property.unit", u.id().value(), u.shortId(), u.id().value(), names(leaving) + " moved out of " + u.unitNo() + " on " + on,
                List.of(new AuditWriter.Change("occupancy", u.occupancy(), occ)));
            return new Outcome(change, store.people(u.id().value(), false), left, gate, closed);
        });
    }

    // ---- the unit is sold or transferred ----------------------------------------------------------------------------------------------------
    public Outcome changeOwner(Caller c, UnitId id, ChangeOwner cmd) {
        Unit u = managed(c, id);
        LocalDate on = day(cmd.on());
        if (cmd.newOwner() == null) throw new DomainException.RuleViolated("owner-required", "Who is the new owner?");
        List<PersonIn> newcomers = new ArrayList<>();
        newcomers.add(new PersonIn(null, cmd.newOwner().name(), cmd.newOwner().phone(), cmd.newOwner().email(), "Owner", true));
        for (PersonIn p : cmd.coOwners() == null ? List.<PersonIn>of() : cmd.coOwners()) newcomers.add(new PersonIn(null, p.name(), p.phone(), p.email(), "Co-owner", false));
        List<In> coming = check(newcomers);
        String occ = pick(Unit.OCCUPANCY, cmd.occupancyAfter(), "Occupied by afterwards");
        String note = note(cmd.note());
        List<UUID> leavingIds = cmd.leavingIds() == null ? List.of() : cmd.leavingIds();
        Map<String, UUID> personOf = resolve(coming);
        return tx.inTx(() -> {
            List<Person> now = store.people(u.id().value(), false);
            List<Person> leaving = now.stream().filter((p) -> leavingIds.contains(p.occupantId())).toList();
            if (leaving.size() != new HashSet<>(leavingIds).size()) throw new DomainException.RuleViolated("not-living-here", "Someone chosen no longer lives in " + u.unitNo() + " - reload");
            Person primary = now.stream().filter((p) -> "Owner".equals(p.relation()) && p.primary()).findFirst().orElse(null);
            if (primary != null && !leaving.contains(primary)) throw new DomainException.RuleViolated("owner-stays", primary.name() + " is the owner now - choose them among those leaving");
            if (leaving.stream().anyMatch((p) -> p.from() != null && p.from().isAfter(on))) throw new DomainException.RuleViolated("before-arrival", "Someone chosen came after that day");
            List<Person> staying = now.stream().filter((p) -> !leaving.contains(p)).toList();
            for (In w : coming) if (staying.stream().anyMatch((p) -> w.phone.equals(p.phone()))) throw new DomainException.RuleViolated("already-here", w.name + " already lives in " + u.unitNo());
            boolean tenantStays = staying.stream().anyMatch((p) -> "Tenant".equals(p.relation()));
            consistent(occ, null, tenantStays);
            UnitPeople.Leftovers left = store.leftovers(u.id().value(), members(leaving), LocalDate.now(clock));
            store.endOccupants(leaving.stream().map(Person::occupantId).toList(), on);
            for (Person p : staying) if ("Owner".equals(p.relation())) store.updateOccupant(p.occupantId(), p.name(), p.email(), "Co-owner", false);   // one owner on the title: the new one
            for (In w : coming) arrive(u, w, personOf.get(w.phone), on);
            int closed = leave(u, leaving);
            UnitPeople.GateEnded gate = !Boolean.FALSE.equals(cmd.endGate()) ? store.endGateAccess(u.id().value()) : new UnitPeople.GateEnded(0, 0, 0, false);
            store.setOccupancy(u.id().value(), occ, tenantStays ? null : "Owner");
            UUID change = store.recordChange(u.id().value(), "Owner changed", on, out(leaving), in(coming), u.occupancy(), occ, left.duesOutstanding(), summary(left, gate, closed), note);
            audit.write(c, AuditWriter.Action.Update, "property.unit", u.id().value(), u.shortId(), u.id().value(), "Owner of " + u.unitNo() + " changed on " + on + ": "
                + (primary == null ? "-" : primary.name()) + " → " + coming.get(0).name, List.of(new AuditWriter.Change("owner", primary == null ? null : primary.name(), coming.get(0).name)));
            return new Outcome(change, store.people(u.id().value(), false), left, gate, closed);
        });
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------------------------------
    /** One person as asked for, checked: a name, a mobile (it is how they sign in), an e-mail if any, a relation. */
    private record In(UUID occupantId, String name, String phone, String email, String relation, boolean primary) {}

    private List<In> check(List<PersonIn> rows) {
        if (rows.size() > 50) throw new DomainException.RuleViolated("too-many", "At most 50 people on a unit");
        List<In> out = new ArrayList<>(); Set<String> phones = new HashSet<>();
        for (PersonIn p : rows) {
            String name = p.name() == null ? "" : p.name().strip().replaceAll("\\s+", " ");
            if (name.isEmpty() || name.length() > 120) throw new DomainException.RuleViolated("bad-name", "Every person needs a name (up to 120 characters)");
            if (p.phone() == null || p.phone().isBlank()) throw new DomainException.RuleViolated("phone-required", name + ": a mobile number is needed - it is how they sign in");
            String phone = Phone.parse(p.phone(), countryCode).e164();
            if (!phones.add(phone)) throw new DomainException.RuleViolated("same-phone", name + ": that number is entered twice - one number is one person");
            String email = p.email() == null || p.email().isBlank() ? null : p.email().strip().toLowerCase(java.util.Locale.ROOT);
            if (email != null && (email.length() > 200 || !email.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+"))) throw new DomainException.RuleViolated("bad-email", name + ": enter a valid e-mail address");
            String rel = pick(RELATIONS, p.relation(), "Relation");
            out.add(new In(p.occupantId(), name, phone, email, rel, "Owner".equals(rel)));
        }
        long owners = out.stream().filter((x) -> "Owner".equals(x.relation)).count();
        if (owners > 1) throw new DomainException.RuleViolated("one-owner", "One primary owner (on the title); the others are co-owners");
        if (owners == 0 && out.stream().anyMatch((x) -> "Co-owner".equals(x.relation))) throw new DomainException.RuleViolated("owner-required", "Name the primary owner too");
        return out;
    }
    /** A tenant on a unit that is not let, or bills to a tenant who is not there, is refused (the same as the app). */
    private static void consistent(String occupancy, String billTo, boolean tenant) {
        if ("Tenant occupied".equals(occupancy) && !tenant) throw new DomainException.RuleViolated("tenant-required", "A tenant-occupied unit needs its tenant");
        if (!"Tenant occupied".equals(occupancy) && tenant) throw new DomainException.RuleViolated("tenant-not-let", "The unit is " + occupancy.toLowerCase() + " but still has a tenant");
        if ("Tenant".equals(billTo) && !tenant) throw new DomainException.RuleViolated("bill-to-tenant", "Bills go to the tenant, but the unit has no tenant");
    }
    private Map<String, UUID> resolve(List<In> rows) {
        Map<String, UUID> out = new HashMap<>();
        for (In w : rows) out.put(w.phone, persons.findOrCreate(new Phone(w.phone), w.name).value());
        return out;
    }
    /** Someone comes: their row from the day, and a sign-in (a new member as owner or resident; a member who had left is back). */
    private void arrive(Unit u, In w, UUID person, LocalDate from) {
        store.addOccupant(u.id().value(), person, w.relation, w.name, w.phone, w.email, w.primary, from);
        var m = store.membership(person);
        String role = "Owner".equals(w.relation) || "Co-owner".equals(w.relation) ? "owner" : "resident";
        if (m.isEmpty()) { UUID id = store.addMembership(person, w.name); store.giveRoleIfNone(id, role); return; }
        if ("Inactive".equals(m.get().status())) { store.setMemberStatus(m.get().id(), "Active"); store.giveRoleIfNone(m.get().id(), role); }
        callers.evict(new MembershipId(m.get().id()));                                // their units changed
    }
    /** Those who left: with no other home here and no other role, their sign-in ends (they are signed out everywhere). Returns how many. */
    private int leave(Unit u, List<Person> leaving) {
        int closed = 0;
        for (Person p : leaving) {
            if (p.personId() == null) continue;
            var m = store.membership(p.personId());
            if (m.isEmpty()) continue;
            boolean onlyHere = !store.hasOtherHome(p.personId(), u.id().value()) && RESIDENT_ROLES.containsAll(m.get().roleCodes());
            if (onlyHere && !"Inactive".equals(m.get().status())) {
                store.setMemberStatus(m.get().id(), "Inactive");
                tokens.revokeAllOfMembership(m.get().id(), "left " + u.unitNo(), clock.instant());
                closed++;
            }
            callers.evict(new MembershipId(m.get().id()));
        }
        return closed;
    }
    private static List<UUID> members(List<Person> ps) { return ps.stream().map(Person::membershipId).filter(Objects::nonNull).toList(); }
    private static List<Map<String, Object>> out(List<Person> ps) {
        return ps.stream().map((p) -> { Map<String, Object> m = new LinkedHashMap<>(); m.put("occupantId", p.occupantId()); m.put("name", p.name()); m.put("relation", p.relation()); return m; }).toList();
    }
    private static List<Map<String, Object>> in(List<In> ps) {
        return ps.stream().map((p) -> { Map<String, Object> m = new LinkedHashMap<>(); m.put("name", p.name); m.put("relation", p.relation); return m; }).toList();
    }
    private static Map<String, Object> summary(UnitPeople.Leftovers l, UnitPeople.GateEnded g, int closed) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("accountsClosed", closed); m.put("unpaidBills", l.unpaidBills()); m.put("futureBookings", l.futureBookings()); m.put("openTickets", l.openTickets());
        m.put("gateLinksEnded", g.links()); m.put("passesCancelled", g.passes()); m.put("vehiclesEnded", g.vehicles());
        return m;
    }
    private static String names(List<Person> ps) { return String.join(", ", ps.stream().map(Person::name).toList()); }
    private LocalDate day(LocalDate on) {
        LocalDate today = LocalDate.now(clock);
        if (on == null) return today;
        if (on.isAfter(today)) throw new DomainException.RuleViolated("future-date", "Record it on the day it happens (not a future date)");
        if (on.isBefore(today.minusYears(2))) throw new DomainException.RuleViolated("too-old", "That date is more than two years ago");
        return on;
    }
    private static String note(String s) {
        if (s == null || s.isBlank()) return null;
        if (s.length() > 2000) throw new DomainException.RuleViolated("too-long", "The note is too long (2000 characters)");
        return s.strip();
    }
    private static String pick(List<String> allowed, String v, String what) {
        String k = v == null ? null : com.communityos.api.shared.domain.Names.pick(allowed, v);
        if (k == null) throw new DomainException.RuleViolated("bad-value", what + " must be one of " + allowed);
        return k;
    }
    private static boolean manager(Caller c) { return c.isSuperAdmin() || (c.has(Permission.MANAGE_UNITS) && !c.isResident()); }
    private Unit managed(Caller c, UnitId id) {
        Unit u = units.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
        if (!manager(c) || !policy.writeScope(c).matches(u)) throw new AccessDenied("Only the community's unit managers change who lives in a unit");
        if ("Archived".equals(u.status())) throw new DomainException.RuleViolated("unit-archived", "An archived unit cannot be changed");
        return u;
    }
}
