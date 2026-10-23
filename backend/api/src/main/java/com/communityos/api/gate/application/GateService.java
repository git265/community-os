package com.communityos.api.gate.application;

import com.communityos.api.gate.application.port.GateDirectory;
import com.communityos.api.gate.application.port.GateStore;
import com.communityos.api.gate.domain.Gate;
import com.communityos.api.gate.domain.StaffBadge;
import com.communityos.api.gate.domain.Gate.VisitState;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * The gate desk and the residents' side of it (the legacy GateGuard engine, on the server):
 *   passes     a resident makes passes for their own unit; the server makes the code; a pass opens the gate only inside its dates, days,
 *              hours and guest limit; a one-time pass is used once
 *   approvals  the guard asks the unit (or, for the common area, the Facility Manager); the first answer wins; no answer in time applies the
 *              unit's (or the quiet hours') fallback; "always allow" leaves a standing pass or allows the delivery company
 *   people     the vetted registry decides: blocked people are refused and flagged; household staff only inside their link's window; crews
 *              only on an active work order's roster (else the FM is asked); delivery riders by the unit's delivery rule
 *   goods      people counted in and out; more than the pass allows is held (or let in and flagged); a different count out is a flag
 *   away       a unit in away mode is asked before anyone comes in for it: pass holders and household staff wait for its answer, a goods
 *              vehicle is held until the guard says why it may open (flagged), deliveries are left at the gate
 *   vehicles   with no tag reader the guard records a registered car in and out by its plate; an entry with no exit is closed by the next entry
 *   reports    a unit reports a household worker to security: security is told at once, and again each time the worker comes to the gate
 *   never silent: an override or a hand-opened gate is always a flag; the sweep raises overstays, closes forgotten pass visits, flags a
 *              guard console left quiet too long and a patrol round not walked
 * Every step publishes an event (gate.*) so notifications can tell the unit or the security team.
 */
public final class GateService {
    public record GateEvent(String topic, UUID aggregateId, CommunityId communityId, UUID unitId, String kind, String state, Instant occurredAt) implements DomainEvent {}
    public record NewPass(String visitorName, String phone, UnitId unit, String type, LocalDate validFrom, LocalDate validTo, LocalTime fromTime, LocalTime toTime, List<String> days,
                          String vehicle, Integer guestCap, String goodsKind, Integer peopleCount, String material, boolean carryingOut, String outItems, String photo) {}
    public record Ask(String kind, String name, String phone, String company, String vehicle, String purpose, UnitId unit, String gate, String photo, UUID personId, UUID workOrderId,
                      Integer headcount, String material, UUID passId) {}
    public record Outcome(boolean ok, String outcome, String reason, Gate.Visit visit, Gate.Approval approval) {
        static Outcome in(Gate.Visit v) { return new Outcome(true, "admitted", null, v, null); }
        static Outcome no(String outcome, String reason) { return new Outcome(false, outcome, reason, null, null); }
    }

    private final GateStore store; private final GateDirectory dir; private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    private final SecureRandom random = new SecureRandom();

    public GateService(GateStore store, GateDirectory dir, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.dir = dir; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }
    private ZonedDateTime now() { return ZonedDateTime.now(clock); }
    static void desk(Caller c) { if (!GatePolicy.gateStaff(c)) throw new AccessDenied("Only the security team works the gate desk"); }

    // ---- reads -------------------------------------------------------------------------------------------------------------------------------------
    public List<Gate.Pass> passes(Caller c, String status) { return store.passes(GatePolicy.byUnit(c, "p.unit_id", (Gate.Pass p) -> p.unit), status); }
    public List<Gate.Visit> visits(Caller c, GateStore.VisitFilter f) { return store.visits(GatePolicy.byUnit(c, "v.unit_id", (Gate.Visit v) -> v.unit), f); }
    public List<Gate.Approval> approvals(Caller c, String status) { return store.approvals(GatePolicy.byUnit(c, "a.unit_id", (Gate.Approval a) -> a.unit), status); }
    /** One record, with the same scope as its list (a unit's own, or all for the security team). */
    public Gate.Pass pass(Caller c, UUID id) { return store.pass(id, GatePolicy.byUnit(c, "p.unit_id", (Gate.Pass p) -> p.unit)).orElseThrow(AccessDenied.NotVisible::new); }
    public Gate.Visit visit(Caller c, UUID id) { return store.visit(id, GatePolicy.byUnit(c, "v.unit_id", (Gate.Visit v) -> v.unit)).orElseThrow(AccessDenied.NotVisible::new); }
    public Gate.Approval approval(Caller c, UUID id) { return store.approval(id, GatePolicy.byUnit(c, "a.unit_id", (Gate.Approval a) -> a.unit)).orElseThrow(AccessDenied.NotVisible::new); }
    public List<Gate.Flag> flags(Caller c, boolean openOnly) { if (!GatePolicy.oversees(c)) throw new AccessDenied("Only the security team and the committee see gate flags"); return store.flags(openOnly); }
    public List<GateStore.Scan> scans(Caller c, LocalDate since) {
        if (!GatePolicy.oversees(c)) throw new AccessDenied("Only the security team and the committee see patrols");
        return store.scansSince(since == null ? now().toLocalDate().minusDays(1) : since);
    }
    /** The guard looks a pass up by its code (or the QR text "GGP|code") or the visitor's name; each comes with why it would not open now. */
    public record PassCheck(Gate.Pass pass, String problem) {}
    public List<PassCheck> findPasses(Caller c, String q) {
        desk(c);
        String t = q == null ? "" : q.strip();
        if (t.toUpperCase().startsWith("GGP|")) t = t.substring(4);
        if (t.length() < 2) return List.of();
        ZonedDateTime now = now();
        return store.passesMatching(t).stream().map((p) -> new PassCheck(p, p.problem(now))).toList();
    }

    // ---- passes (residents and the desk) -----------------------------------------------------------------------------------------------------------
    public Gate.Pass createPass(Caller c, NewPass n) {
        if (c.membership() == null) throw new AccessDenied("Sign in to make a pass");
        UnitId unit = n.unit() != null ? n.unit() : c.hasHome() && c.units().size() == 1 ? c.units().iterator().next() : null;
        if (unit == null && !GatePolicy.gateStaff(c)) throw new DomainException.RuleViolated("unit-required", "Say which unit the pass is for");
        if (!GatePolicy.gateStaff(c) && !c.units().contains(unit)) throw new AccessDenied("A unit manages only its own guest passes");
        String type = n.type() == null ? "One-time" : n.type();
        if (!Gate.PASS_TYPES.contains(type)) throw new DomainException.RuleViolated("bad-type", "A pass is One-time, Recurring, Event or Goods");
        String name = n.visitorName() == null ? "" : n.visitorName().strip();
        if (name.isEmpty() || name.length() > 120) throw new DomainException.RuleViolated("name-required", "Who is the pass for?");
        LocalDate today = now().toLocalDate();
        LocalDate from = n.validFrom() == null ? today : n.validFrom();
        LocalDate to = n.validTo() == null ? ("Recurring".equals(type) ? from.plusMonths(1) : from) : n.validTo();
        if (to.isBefore(from)) throw new DomainException.RuleViolated("bad-dates", "The pass ends before it starts");
        if (to.isBefore(today)) throw new DomainException.RuleViolated("past", "That pass would already be over");
        if (!GatePolicy.gateStaff(c) && from.plusYears(1).isBefore(to)) throw new DomainException.RuleViolated("too-long", "A pass lasts at most a year");
        for (String d : n.days() == null ? List.<String>of() : n.days()) if (!Gate.DAYS.contains(d)) throw new DomainException.RuleViolated("bad-day", "Days are Mon to Sun");
        if ("Event".equals(type) && (n.guestCap() == null || n.guestCap() < 1 || n.guestCap() > 2000)) throw new DomainException.RuleViolated("cap-required", "How many guests may come with an event pass (1 to 2000)?");
        if ("Goods".equals(type) && (n.peopleCount() == null || n.peopleCount() < 1)) throw new DomainException.RuleViolated("people-required", "How many people come with the goods vehicle?");
        if ("Goods".equals(type) && blank(n.vehicle()) == null) throw new DomainException.RuleViolated("vehicle-required", "Which vehicle brings the goods (its number)?");
        if (n.carryingOut() && blank(n.outItems()) == null) throw new DomainException.RuleViolated("items-required", "List what is being taken out - the guard checks it at the gate");
        Gate.Pass p = new Gate.Pass();
        p.id = UUID.randomUUID(); p.visitorName = name; p.phone = com.communityos.api.shared.resource.Checks.phone(n.phone(), "Phone", false); p.unit = unit; p.type = type; p.validFrom = from; p.validTo = to; p.fromTime = n.fromTime(); p.toTime = n.toTime();
        p.days = n.days() == null ? List.of() : List.copyOf(n.days()); p.vehicle = blank(n.vehicle()); p.guestCap = n.guestCap(); p.goodsKind = blank(n.goodsKind()); p.peopleCount = n.peopleCount();
        p.material = blank(n.material()); p.carryingOut = n.carryingOut(); p.outItems = blank(n.outItems()); p.photo = blank(n.photo()); p.hostName = c.displayName();
        p.createdBy = c.membership().value();
        return tx.inTx(() -> {
            for (int i = 0; ; i++) {
                p.code = String.valueOf(100000 + random.nextInt(900000));
                if (!store.codeInUse(p.code)) break;
                if (i > 20) throw new IllegalStateException("no free pass code");
            }
            store.insert(p);
            done(c, "gate.pass.created", p.id, p.unit, p.type, p.status, AuditWriter.Action.Create, "gate.pass", p.shortId, "Pass " + p.shortId + " (" + type + ") for " + name);
            return p;
        });
    }
    public Gate.Pass cancelPass(Caller c, UUID id, long version) {
        return tx.inTx(() -> {
            Gate.Pass p = store.pass(id, GatePolicy.byUnit(c, "p.unit_id", (Gate.Pass x) -> x.unit)).orElseThrow(AccessDenied.NotVisible::new);
            if (!GatePolicy.gateStaff(c) && !c.units().contains(p.unit)) throw new AccessDenied("A unit manages only its own guest passes");
            if (p.version != version) throw new DomainException.Conflict("Pass " + p.shortId);
            if (!"Active".equals(p.status)) throw new DomainException.RuleViolated("not-active", "This pass is already " + p.status.toLowerCase());
            p.status = "Cancelled";
            if (!store.save(p)) throw new DomainException.Conflict("Pass " + p.shortId);
            done(c, "gate.pass.cancelled", p.id, p.unit, p.type, p.status, AuditWriter.Action.Update, "gate.pass", p.shortId, "Cancelled pass " + p.shortId);
            return p;
        });
    }

    // ---- the desk: passes, approvals ---------------------------------------------------------------------------------------------------------------
    public Outcome admitPass(Caller c, UUID passId, String gate, String vehicle, String photo) {
        desk(c);
        return tx.inTx(() -> {
            Gate.Pass p = store.pass(passId, com.communityos.api.shared.access.Spec.all()).orElseThrow(AccessDenied.NotVisible::new);
            if ("Goods".equals(p.type)) return Outcome.no("goods", "A goods pass is admitted with a head count");
            String bad = p.problem(now());
            if (!bad.isEmpty()) return Outcome.no("pass", bad);
            if (p.unit != null && dir.unitRule(p.unit).awayMode()) {   // away: even a pass holder waits for the unit's answer (the pass is used once they are let in)
                Outcome r = askInTx(c, new Ask("Guest", p.visitorName, p.phone, null, blank(vehicle) != null ? vehicle.strip() : p.vehicle, p.type + " pass · the unit is away", p.unit, gate,
                    blank(photo) != null ? photo : p.photo, null, null, null, null, p.id));
                return new Outcome(false, "ask", nz(p.unitNo, "The unit") + " is in away mode, so they have been asked first", r.visit(), r.approval());
            }
            Gate.Visit v = visit(c, "Guest", p.visitorName, p.unit, gate, "QR / OTP", VisitState.INSIDE);
            v.phone = p.phone; v.vehicle = blank(vehicle) != null ? vehicle.strip() : p.vehicle; v.photo = blank(photo) != null ? photo : p.photo; v.passId = p.id; v.purpose = p.type + " pass";
            store.insert(v);
            p.used();
            if (!store.save(p)) throw new DomainException.Conflict("Pass " + p.shortId);
            done(c, "gate.guest.arrived", v.id, v.unit, v.kind, v.state.label, AuditWriter.Action.Create, "gate.visit", v.shortId, v.name + " in with pass " + p.shortId);
            return Outcome.in(v);
        });
    }

    /** Ask the unit (or, for the common area, the Facility Manager) to let someone in; the visit waits for the answer. */
    public Outcome ask(Caller c, Ask a) {
        desk(c);
        return tx.inTx(() -> askInTx(c, a));
    }
    private Outcome askInTx(Caller c, Ask a) {
        Gate.Settings s = dir.settings(); ZonedDateTime now = now();
        if (a.name() == null || a.name().isBlank()) throw new DomainException.RuleViolated("name-required", "Who is at the gate?");
        String kind = a.kind() == null ? "Guest" : a.kind();
        if (!Gate.KINDS.contains(kind)) throw new DomainException.RuleViolated("bad-kind", "Unknown kind of visitor");
        Gate.UnitRule rule = a.unit() == null ? null : dir.unitRule(a.unit());
        String fallback = s.quiet(now) ? s.quietFallback() : rule != null && rule.fallback() != null && !"Community default".equals(rule.fallback()) ? rule.fallback() : s.fallback();
        Gate.Visit v = visit(c, kind, a.name().strip(), a.unit(), a.gate(), "Guard approval", VisitState.AWAITING);
        v.phone = blank(a.phone()); v.company = blank(a.company()); v.vehicle = blank(a.vehicle()); v.purpose = blank(a.purpose()); v.photo = blank(a.photo()); v.personId = a.personId();
        v.workOrderId = a.workOrderId(); v.headcountIn = a.headcount(); v.headcountExpected = a.headcount(); v.material = blank(a.material()); v.passId = a.passId();
        v.inAt = null; v.expectedUntil = null;
        Gate.Approval ap = new Gate.Approval();
        ap.id = UUID.randomUUID(); ap.visitId = v.id; ap.kind = kind; ap.name = v.name; ap.unit = a.unit(); ap.company = v.company; ap.purpose = v.purpose; ap.vehicle = v.vehicle; ap.gate = v.gate;
        ap.photo = v.photo; ap.requestedAt = clock.instant(); ap.expiresAt = ap.requestedAt.plusSeconds(Math.max(10, s.waitSeconds())); ap.fallback = fallback == null ? "Hold at gate" : fallback;
        store.insert(ap);
        v.approvalId = ap.id;
        store.insert(v);
        done(c, "gate.approval.requested", ap.id, ap.unit, kind, ap.status, AuditWriter.Action.Create, "gate.approval", ap.shortId, "Asked " + (ap.unit == null ? "the Facility Manager" : "the unit") + " about " + v.name);
        return new Outcome(false, "ask", null, v, ap);
    }

    /** The unit (or the FM for the common area) answers. The first answer wins; later ones change nothing. */
    public Gate.Approval answer(Caller c, UUID approvalId, String decision, boolean always) {
        if (!"Approved".equals(decision) && !"Denied".equals(decision)) throw new DomainException.RuleViolated("bad-answer", "Approve or deny");
        return tx.inTx(() -> {
            Gate.Approval ap = store.approval(approvalId, GatePolicy.byUnit(c, "a.unit_id", (Gate.Approval x) -> x.unit)).orElseThrow(AccessDenied.NotVisible::new);
            boolean mine = ap.unit != null ? c.units().contains(ap.unit) : GatePolicy.gateOrFm(c);
            if (!mine && !c.isSuperAdmin()) throw new AccessDenied(ap.unit == null ? "The Facility Manager answers for the common area" : "This approval is for another unit");
            if (!ap.open()) return ap;                                                     // first answer wins
            ap.status = decision; ap.answeredAt = clock.instant(); ap.answeredBy = c.membership() == null ? null : c.membership().value(); ap.answeredByName = c.displayName();
            ap.alwaysAllow = always && "Approved".equals(decision);
            if (!store.save(ap)) throw new DomainException.Conflict("Approval " + ap.shortId);
            store.visit(ap.visitId, com.communityos.api.shared.access.Spec.all()).ifPresent((v) -> {
                if (v.state == VisitState.AWAITING || v.state == VisitState.NO_ANSWER) {
                    v.move("Approved".equals(decision) ? VisitState.APPROVED : VisitState.DENIED);
                    if (v.state == VisitState.DENIED) v.outAt = clock.instant();
                    if (!store.save(v)) throw new DomainException.Conflict("Visit " + v.shortId);
                }
            });
            if (ap.alwaysAllow && ap.unit != null) {
                if ("Delivery".equals(ap.kind) && ap.company != null) dir.allowCompany(ap.unit, ap.company);
                else {
                    Gate.Pass p = new Gate.Pass();
                    p.id = UUID.randomUUID(); p.visitorName = ap.name; p.unit = ap.unit; p.type = "Recurring"; p.validFrom = now().toLocalDate(); p.validTo = p.validFrom.plusYears(1);
                    p.vehicle = ap.vehicle; p.photo = ap.photo; p.hostName = c.displayName(); p.createdBy = ap.answeredBy;
                    do { p.code = String.valueOf(100000 + random.nextInt(900000)); } while (store.codeInUse(p.code));
                    store.insert(p);
                }
            }
            done(c, "gate.approval.answered", ap.id, ap.unit, ap.kind, ap.status, AuditWriter.Action.Update, "gate.approval", ap.shortId, decision + " " + ap.name + (ap.alwaysAllow ? " (always)" : ""));
            return ap;
        });
    }

    /** Open for a visitor the unit approved. Opening by hand needs a reason and is flagged; a denied or unanswered visitor needs an override. */
    public Gate.Visit admitApproved(Caller c, UUID visitId, long version, String manualReason) {
        desk(c);
        return changeVisit(c, visitId, version, (v) -> {
            if (v.state != VisitState.APPROVED) throw new DomainException.RuleViolated("not-approved", "This visitor is not approved" + (v.state == VisitState.DENIED ? " - the unit said no" : " yet"));
            v.move(VisitState.INSIDE); v.inAt = clock.instant(); v.expectedUntil = expected(v.kind, null, null);
            v.method = blank(manualReason) != null ? "Manual open" : "Guard approval"; v.openReason = blank(manualReason);
            if (v.openReason != null) flag(c, "Manual open", v, "Opened by hand by " + c.displayName() + ". Reason: " + v.openReason + ".");
            if (v.passId != null) store.pass(v.passId, com.communityos.api.shared.access.Spec.all()).ifPresent((p) -> { p.used(); if (!store.save(p)) throw new DomainException.Conflict("Pass " + p.shortId); });
            return "Let in " + v.name;
        }, "gate.visit.admitted");
    }
    /** Ask again (a fresh wait) for a visitor whose unit did not answer. */
    public Outcome askAgain(Caller c, UUID visitId, long version) {
        desk(c);
        return tx.inTx(() -> {
            Gate.Visit v = store.visit(visitId, com.communityos.api.shared.access.Spec.all()).orElseThrow(AccessDenied.NotVisible::new);
            if (v.version != version) throw new DomainException.Conflict("Visit " + v.shortId);
            if (v.state != VisitState.NO_ANSWER && v.state != VisitState.AWAITING) throw new DomainException.RuleViolated("not-waiting", "This visitor is not waiting for an answer");
            v.move(VisitState.REFUSED); v.outAt = clock.instant(); v.note = "Asked again";
            if (!store.save(v)) throw new DomainException.Conflict("Visit " + v.shortId);
            return askInTx(c, new Ask(v.kind, v.name, v.phone, v.company, v.vehicle, v.purpose, v.unit, v.gate, v.photo, v.personId, v.workOrderId, v.headcountIn, v.material, v.passId));
        });
    }
    public Gate.Visit refuse(Caller c, UUID visitId, long version, String note) {
        desk(c);
        return changeVisit(c, visitId, version, (v) -> { v.move(VisitState.REFUSED); v.outAt = clock.instant(); v.note = blank(note) != null ? note.strip() : v.note; return "Refused " + v.name; }, "gate.visit.refused");
    }
    public Gate.Visit exit(Caller c, UUID visitId, long version, String method) {
        desk(c);
        return changeVisit(c, visitId, version, (v) -> {
            if ("Goods vehicle".equals(v.kind)) throw new DomainException.RuleViolated("count-out", "A goods vehicle leaves with a head count");
            v.move(VisitState.EXITED); v.outAt = clock.instant(); v.outMethod = blank(method) == null ? "Guard" : method; return v.name + " left";
        }, "gate.visit.exited");
    }

    /** The guard opens with no pass and no record: allowed, never silent. */
    public Gate.Visit override(Caller c, String name, String reason, String photo, UnitId unit, String gate, String vehicle) {
        desk(c);
        if (blank(reason) == null) throw new DomainException.RuleViolated("reason-required", "Say why the gate is opened without a pass or an approval");
        return tx.inTx(() -> {
            Gate.Visit v = visit(c, "Other", blank(name) == null ? "Unidentified person" : name.strip(), unit, gate, "Override", VisitState.INSIDE);
            v.vehicle = blank(vehicle); v.photo = blank(photo); v.purpose = "Guard override"; v.note = reason.strip();
            store.insert(v);
            flag(c, "Override entry", v, "Reason given: " + reason.strip());
            done(c, "gate.visit.override", v.id, v.unit, v.kind, v.state.label, AuditWriter.Action.Create, "gate.visit", v.shortId, "Override entry: " + v.name + " - " + reason.strip());
            return v;
        });
    }

    // ---- the vetted registry at the gate ---------------------------------------------------------------------------------------------------------
    public Outcome admitPerson(Caller c, UUID personId, String gate, String method, UnitId wanted) {
        desk(c);
        return tx.inTx(() -> {
            Gate.Person p = dir.person(personId).orElseThrow(AccessDenied.NotVisible::new);
            String how = blank(method) == null ? "Guard manual" : method;
            if (store.insideByPerson(p.id()).isPresent()) return Outcome.no("already-inside", p.name() + " is already inside");
            if ("Blocked".equals(p.status())) {
                Gate.Visit r = visit(c, "Other", p.name(), null, gate, how, VisitState.REFUSED); r.personId = p.id(); r.photo = p.photo(); r.note = "Blocked"; r.outAt = clock.instant();
                store.insert(r);
                flag(c, "Blocked person attempt", r, (p.statusReason() == null ? "Blocked person" : p.statusReason()) + " tried to enter (" + how.toLowerCase() + ").");
                return Outcome.no("blocked", "This person is blocked");
            }
            if (!"Active".equals(p.status())) return Outcome.no("not-active", "Not cleared for entry (" + p.status() + ")");
            LocalDate today = now().toLocalDate();
            if ((p.policeExpiry() != null && today.isAfter(p.policeExpiry())) || ("Driver".equals(p.personClass()) && p.licenceExpiry() != null && today.isAfter(p.licenceExpiry())))
                return Outcome.no("expired", "A document has expired; the person must be re-validated");
            if (Gate.VILLA_CLASSES.contains(p.personClass())) {
                List<Gate.Link> mine = dir.links(p.id()).stream().filter((l) -> !"Ended".equals(l.status())).toList();
                List<Gate.Link> ok = mine.stream().filter((l) -> Gate.windowOpen(l.days(), l.fromTime(), l.toTime(), now(), 15)).toList();
                String kind = "Driver".equals(p.personClass()) ? "Driver" : "Maid / cook";
                List<Gate.Flag> reports = store.openReports(p.id());
                String alert = reports.isEmpty() ? null : reports.get(0).detail;
                if (alert != null && ok.isEmpty()) {   // reported, and no unit she may still come to now: turned away, security told
                    Gate.Visit r = visit(c, kind, p.name(), reports.get(0).unit, gate, how, VisitState.REFUSED); r.personId = p.id(); r.photo = p.photo(); r.outAt = clock.instant();
                    r.note = "Reported to security"; store.insert(r);
                    flag(c, Gate.REPORTED, r, p.name() + " came to " + r.gate + " and was turned away. " + alert + ".");
                    return Outcome.no("reported", alert + ". Do not let in - call the security supervisor");
                }
                if (ok.isEmpty()) {
                    Gate.Visit r = visit(c, kind, p.name(), mine.isEmpty() ? null : mine.get(0).unit(), gate, how, VisitState.REFUSED); r.personId = p.id(); r.photo = p.photo(); r.outAt = clock.instant();
                    r.note = "Outside allowed window"; store.insert(r);
                    flag(c, "Wrong destination", r, mine.isEmpty() ? p.name() + " is not linked to any unit." : p.name() + " arrived outside the allowed days or hours.");
                    return Outcome.no("window", mine.isEmpty() ? "Not linked to any unit" : "Outside the allowed days or hours");
                }
                List<Gate.Link> home = ok.stream().filter((l) -> !dir.unitRule(l.unit()).awayMode()).toList();
                if (home.isEmpty()) {   // every unit she may come to now is away: the unit is asked
                    Gate.Link to = ok.stream().filter((l) -> l.unit().equals(wanted)).findFirst().orElse(ok.get(0));
                    Outcome r = askInTx(c, new Ask(kind, p.name(), p.phone(), null, p.vehicleNo(), p.personClass() + " · the unit is away", to.unit(), gate, p.photo(), p.id(), null, null, null, null));
                    if (alert != null) flag(c, Gate.REPORTED, r.visit(), p.name() + " came to " + r.visit().gate + "; " + to.unitNo() + " was asked. " + alert + ".");
                    return new Outcome(false, "ask", to.unitNo() + " is in away mode, so they have been asked first", r.visit(), r.approval());
                }
                ok = home;
                Gate.Link first = ok.stream().filter((l) -> l.unit().equals(wanted)).findFirst().orElse(ok.get(0));
                Gate.Visit v = visit(c, kind, p.name(), first.unit(), gate, how, VisitState.INSIDE);
                v.phone = p.phone(); v.photo = p.photo(); v.personId = p.id(); v.purpose = p.personClass(); v.vehicle = p.vehicleNo(); v.expectedUntil = expected(kind, first.toTime(), null);
                if (ok.size() > 1) v.note = "Also works at " + String.join(", ", ok.stream().filter((l) -> l != first).map(Gate.Link::unitNo).toList());
                store.insert(v);
                for (Gate.Link l : ok) events.publish(List.of(new GateEvent("gate.staff.arrived", v.id, c.community(), l.unit().value(), kind, v.state.label, clock.instant())));
                audit.write(c, AuditWriter.Action.Create, "gate.visit", v.id, v.shortId, v.unit == null ? null : v.unit.value(), p.name() + " in (" + p.personClass() + ")", List.of());
                if (alert != null) { flag(c, Gate.REPORTED, v, p.name() + " came in to " + first.unitNo() + " at " + v.gate + ". " + alert + "."); return new Outcome(true, "admitted", alert + ". Security has been told", v, null); }
                return Outcome.in(v);
            }
            if (Gate.CREW_CLASSES.contains(p.personClass())) {
                Optional<Gate.WorkOrder> order = dir.activeWorkOrders().stream().filter((o) -> o.rosterIds().contains(p.id()) && Gate.windowOpen(o.days(), o.fromTime(), o.toTime(), now(), 30)).findFirst();
                if (order.isEmpty()) {
                    Outcome r = askInTx(c, new Ask("Crew", p.name(), p.phone(), p.vendor(), null, "Not on today's roster" + (p.vendor() == null ? "" : " · " + p.vendor()), null, gate, p.photo(), p.id(), null, null, null, null));
                    return new Outcome(false, "needs-approval", "Not on today's roster: sent to the Facility Manager", r.visit(), r.approval());
                }
                Gate.Visit v = visit(c, "Crew", p.name(), null, gate, how, VisitState.INSIDE);
                v.phone = p.phone(); v.photo = p.photo(); v.personId = p.id(); v.company = p.vendor() != null ? p.vendor() : order.get().vendor(); v.workOrderId = order.get().id();
                v.purpose = order.get().title(); v.expectedUntil = expected("Crew", null, order.get().toTime());
                store.insert(v);
                done(c, "gate.crew.arrived", v.id, null, v.kind, v.state.label, AuditWriter.Action.Create, "gate.visit", v.shortId, p.name() + " in on " + order.get().title());
                return Outcome.in(v);
            }
            if ("Delivery rider".equals(p.personClass())) {
                if (wanted == null) return Outcome.no("need-unit", "Which unit is the delivery for?");
                return deliveryInTx(c, p, p.name(), p.phone(), p.photo(), p.deliveryCompany() == null ? "Other" : p.deliveryCompany(), wanted, gate, p.vehicleNo(), how);
            }
            Gate.Visit v = visit(c, "Other", p.name(), wanted, gate, how, VisitState.INSIDE); v.phone = p.phone(); v.photo = p.photo(); v.personId = p.id();
            store.insert(v);
            done(c, "gate.visit.admitted", v.id, v.unit == null ? null : v.unit, v.kind, v.state.label, AuditWriter.Action.Create, "gate.visit", v.shortId, p.name() + " in");
            return Outcome.in(v);
        });
    }
    public Gate.Visit exitPerson(Caller c, UUID personId, String method) {
        desk(c);
        Gate.Visit v = store.insideByPerson(personId).orElseThrow(() -> new DomainException.RuleViolated("not-inside", "No open visit for this person"));
        return exit(c, v.id, v.version, method);
    }

    // ---- staff badges -----------------------------------------------------------------------------------------------------------------------------
    public record Badge(String text, int secondsLeft) {}
    public record BadgeHolder(UUID memberId, String name, String roleName, String direction) {}

    /** My badge now: staff only, signed with the community's key on the server. */
    public Badge myBadge(Caller c) {
        if (c.membership() == null || c.category() != Caller.Category.Staff) throw new AccessDenied("Only staff have a gate badge");
        Instant now = clock.instant();
        return new Badge(StaffBadge.text(tx.inTx(store::badgeKey), c.membership().value(), now), StaffBadge.secondsLeft(now));
    }
    /** The guard scans a badge: whose it is and whether they are coming in or going out (nothing is recorded yet). */
    public BadgeHolder checkBadge(Caller c, String text) {
        desk(c);
        return tx.inTx(() -> {
            Gate.Staff who = badgeHolder(text).who();
            return new BadgeHolder(who.memberId(), who.name(), who.roleName(), store.insideByMember(who.memberId()).isPresent() ? "Out" : "In");
        });
    }
    /** Record the badge: opens the staff member's visit, or closes the open one. A code is used once. */
    public Outcome badge(Caller c, String text, String gate) {
        desk(c);
        return tx.inTx(() -> {
            Held held = badgeHolder(text); Gate.Staff who = held.who();
            if (!store.useBadge(who.memberId(), held.window())) throw new DomainException.RuleViolated("badge-used", "This badge code was used already - ask for the next one");
            Optional<Gate.Visit> open = store.insideByMember(who.memberId());
            if (open.isPresent()) {
                Gate.Visit v = open.get();
                v.move(VisitState.EXITED); v.outAt = clock.instant(); v.outMethod = "Staff badge";
                if (!store.save(v)) throw new DomainException.Conflict("Visit " + v.shortId);
                done(c, "gate.staff.left", v.id, null, v.kind, v.state.label, AuditWriter.Action.Update, "gate.visit", v.shortId, who.name() + " out (staff badge)");
                return new Outcome(true, "out", null, v, null);
            }
            Gate.Visit v = visit(c, "Staff", who.name(), null, gate, "Staff badge", VisitState.INSIDE);
            v.memberId = who.memberId(); v.purpose = who.roleName() == null ? "Staff" : who.roleName(); v.expectedUntil = null;   // staff are not overstaying visitors
            store.insert(v);
            done(c, "gate.staff.arrived", v.id, null, v.kind, v.state.label, AuditWriter.Action.Create, "gate.visit", v.shortId, who.name() + " in (staff badge)");
            return Outcome.in(v);
        });
    }
    private record Held(Gate.Staff who, long window) {}
    private Held badgeHolder(String text) {
        StaffBadge.Code code = StaffBadge.check(store.badgeKey(), text, clock.instant());
        Gate.Staff who = dir.staff(code.member()).orElseThrow(() -> new DomainException.RuleViolated("badge-unknown", "No such staff member"));
        if (!who.active()) throw new DomainException.RuleViolated("badge-inactive", who.name() + " is no longer active");
        if (!who.staff()) throw new DomainException.RuleViolated("badge-not-staff", who.name() + " is not on the staff");
        return new Held(who, code.window());
    }

    /** A delivery for a unit: the unit's rule (away = leave at the gate; expecting = let in; listed companies) and the community's approved companies. */
    public Outcome delivery(Caller c, String name, String phone, String photo, String company, UnitId unit, String gate, String vehicle) {
        desk(c);
        if (unit == null) throw new DomainException.RuleViolated("unit-required", "Which unit is the delivery for?");
        return tx.inTx(() -> deliveryInTx(c, null, blank(name) == null ? "Delivery rider" : name.strip(), phone, photo, blank(company) == null ? "Other" : company, unit, gate, vehicle, "Guard manual"));
    }
    private Outcome deliveryInTx(Caller c, Gate.Person person, String who, String phone, String photo, String company, UnitId unit, String gate, String vehicle, String method) {
        Gate.Settings s = dir.settings(); Gate.UnitRule rule = dir.unitRule(unit);
        boolean approved = s.approvedCompanies().contains(company);
        boolean expecting = rule.expectingUntil() != null && rule.expectingUntil().isAfter(clock.instant());
        String mode = rule.deliveryMode() == null ? "Allow listed" : rule.deliveryMode();
        if (rule.awayMode()) mode = "Leave at gate"; else if (expecting && !"Leave at gate".equals(mode)) mode = "Allow all";
        if ("Leave at gate".equals(mode)) {
            Gate.Visit v = visit(c, "Delivery", who, unit, gate, method, VisitState.LEFT_AT_GATE); v.company = company; v.phone = blank(phone); v.photo = blank(photo); v.vehicle = blank(vehicle);
            v.personId = person == null ? null : person.id(); v.purpose = company + " delivery"; v.note = "Left at gate"; v.inAt = clock.instant(); v.outAt = clock.instant(); v.expectedUntil = null;
            store.insert(v);
            done(c, "gate.delivery.left", v.id, unit, v.kind, v.state.label, AuditWriter.Action.Create, "gate.visit", v.shortId, company + " delivery left at the gate");
            return new Outcome(true, "left", null, v, null);
        }
        boolean listed = rule.companies().isEmpty() ? approved : rule.companies().contains(company);
        boolean free = approved && ("Allow all".equals(mode) || ("Allow listed".equals(mode) && listed));
        if (!free) {
            Outcome r = askInTx(c, new Ask("Delivery", who, phone, company, vehicle, company + " delivery", unit, gate, photo, person == null ? null : person.id(), null, null, null, null));
            return new Outcome(false, "ask", approved ? "The unit asked to be asked" : company + " is not an approved delivery company", r.visit(), r.approval());
        }
        Gate.Visit v = visit(c, "Delivery", who, unit, gate, "Pre-approved", VisitState.INSIDE); v.company = company; v.phone = blank(phone); v.photo = blank(photo); v.vehicle = blank(vehicle);
        v.personId = person == null ? null : person.id(); v.purpose = company + " delivery";
        store.insert(v);
        done(c, "gate.delivery.arrived", v.id, unit, v.kind, v.state.label, AuditWriter.Action.Create, "gate.visit", v.shortId, company + " delivery in");
        return Outcome.in(v);
    }

    // ---- goods vehicles: people counted in and out ---------------------------------------------------------------------------------------------
    public Outcome admitGoods(Caller c, UUID passId, String gate, int people, String vehicle, String photo, String force) {
        desk(c);
        return tx.inTx(() -> {
            Gate.Pass p = store.pass(passId, com.communityos.api.shared.access.Spec.all()).orElseThrow(AccessDenied.NotVisible::new);
            String bad = p.problem(now());
            if (!bad.isEmpty()) return Outcome.no("pass", bad);
            if (people < 1) return Outcome.no("count", "Count the people in the vehicle, driver included");
            if (store.insideByPass(p.id).isPresent()) return Outcome.no("inside", "This vehicle is already inside");
            Gate.Settings s = dir.settings();
            boolean away = p.unit != null && dir.unitRule(p.unit).awayMode();
            String plate = blank(vehicle) != null ? vehicle.strip() : p.vehicle;
            boolean wrongPlate = p.vehicle != null && blank(vehicle) != null && !norm(p.vehicle).equals(norm(vehicle));
            int expectedPeople = p.peopleCount == null ? 0 : p.peopleCount;
            boolean extra = expectedPeople > 0 && people > expectedPeople;
            String why = blank(force);
            if (wrongPlate && why == null) return Outcome.no("plate", "The plate is " + vehicle + " but the pass is for " + p.vehicle);
            if (away && why == null) return Outcome.no("away", nz(p.unitNo, "The unit") + " is in away mode. Open only if the resident confirms");
            if (extra && why == null && !"Let in and flag".equals(s.goodsExtraPeople())) return new Outcome(false, "headcount", people + " people counted but the pass allows " + expectedPeople, null, null);
            Gate.Visit v = visit(c, "Goods vehicle", p.visitorName, p.unit, gate, why != null ? "Manual open" : "Goods pass", VisitState.INSIDE);
            v.phone = p.phone; v.vehicle = plate; v.photo = blank(photo) != null ? photo : p.photo; v.passId = p.id; v.headcountExpected = expectedPeople; v.headcountIn = people;
            v.material = p.material; v.carryingOut = p.carryingOut; v.outItems = p.outItems; v.openReason = why;
            v.purpose = String.join(" · ", java.util.stream.Stream.of(p.goodsKind, p.material).filter(Objects::nonNull).toList());
            v.expectedUntil = expected("Goods vehicle", null, p.toTime);
            store.insert(v);
            p.usedCount++;
            if (!store.save(p)) throw new DomainException.Conflict("Pass " + p.shortId);
            if (wrongPlate) flag(c, "Manual open", v, "Plate " + vehicle + " let in on a pass for " + p.vehicle + ". Reason: " + why + ".");
            if (away) flag(c, "Manual open", v, nz(p.unitNo, "The unit") + " is in away mode; the guard let the vehicle in. Reason: " + why + ".");
            if (extra) flag(c, "Headcount mismatch", v, people + " people counted in, the pass allows " + expectedPeople + "." + (why != null ? " Guard confirmed: " + why + "." : ""));
            done(c, "gate.guest.arrived", v.id, v.unit, v.kind, v.state.label, AuditWriter.Action.Create, "gate.visit", v.shortId, "Goods vehicle " + plate + " in with " + people);
            return Outcome.in(v);
        });
    }
    public Gate.Visit exitGoods(Caller c, UUID visitId, long version, int people, boolean itemsChecked) {
        desk(c);
        if (people < 0) throw new DomainException.RuleViolated("count", "Count the people leaving, driver included");
        return changeVisit(c, visitId, version, (v) -> {
            if (!"Goods vehicle".equals(v.kind)) throw new DomainException.RuleViolated("not-goods", "Not a goods vehicle");
            if (v.carryingOut && !itemsChecked) throw new DomainException.RuleViolated("items", "Check the items against the out-pass" + (v.outItems == null ? "" : ": " + v.outItems));
            v.move(VisitState.EXITED); v.outAt = clock.instant(); v.outMethod = "Guard"; v.headcountOut = people;
            if (!Objects.equals(v.headcountIn, people))
                flag(c, "Headcount mismatch", v, v.headcountIn + " people came in and " + people + " left" + (v.headcountIn != null && people < v.headcountIn ? ". " + (v.headcountIn - people) + " may still be inside." : "."));
            return v.vehicle + " left with " + people;
        }, "gate.visit.exited");
    }

    // ---- registered vehicles without a tag reader ------------------------------------------------------------------------------------------------
    /** The guard records a registered vehicle by its plate. In: an older entry with no exit is closed first. Out with no entry: the exit is still written down. */
    public Outcome vehicleAtGate(Caller c, String plate, String gate, String direction) {
        desk(c);
        if (blank(plate) == null) throw new DomainException.RuleViolated("plate-required", "Which plate?");
        boolean out = "Out".equals(direction);
        return tx.inTx(() -> {
            Gate.Vehicle veh = dir.vehicleByPlate(norm(plate)).orElse(null);
            if (veh == null) return Outcome.no("unknown", "This plate is not registered. Use Visitor without a pass");
            if (veh.recurringGoods()) return Outcome.no("goods", "A regular goods vehicle comes in on a goods pass, with its people counted");
            String who = blank(veh.owner()) != null ? veh.owner() : veh.plate(), how = "Guard (plate)";
            Instant now = clock.instant();
            if ("Blocked".equals(veh.status()) && !out) {
                Gate.Visit r = visit(c, "Resident vehicle", who, veh.unit(), gate, how, VisitState.REFUSED); r.vehicle = veh.plate(); r.note = "Blocked vehicle"; store.insert(r);
                flag(c, "Blocked person attempt", r, "Blocked vehicle " + veh.plate() + " came to " + r.gate + ".");
                return Outcome.no("blocked", "This vehicle is blocked");
            }
            Optional<Gate.Visit> open = store.insideByPlate(norm(veh.plate()));
            if (out && open.isPresent()) {
                Gate.Visit v = open.get();
                v.move(VisitState.EXITED); v.outAt = now; v.outMethod = how;
                if (!store.save(v)) throw new DomainException.Conflict("Visit " + v.shortId);
                done(c, "gate.vehicle.out", v.id, v.unit, v.kind, v.state.label, AuditWriter.Action.Update, "gate.visit", v.shortId, veh.plate() + " out");
                return new Outcome(true, "exited", null, v, null);
            }
            if (!out && open.isPresent()) {   // it left without being recorded: that entry closes now
                Gate.Visit old = open.get();
                old.move(VisitState.AUTO_CLOSED); old.outAt = now; old.outMethod = "No exit read";
                if (!store.save(old)) throw new DomainException.Conflict("Visit " + old.shortId);
            }
            Gate.Visit v = visit(c, "Resident vehicle", who, veh.unit(), gate, how, out ? VisitState.EXITED : VisitState.INSIDE);
            v.vehicle = veh.plate(); v.purpose = nz(veh.vehicleClass(), "Resident") + " vehicle"; v.expectedUntil = null;
            if (out) { v.inAt = now; v.outAt = now; v.outMethod = how; v.note = "No entry on record"; }
            store.insert(v);
            done(c, out ? "gate.vehicle.out" : "gate.vehicle.in", v.id, v.unit, v.kind, v.state.label, AuditWriter.Action.Create, "gate.visit", v.shortId, veh.plate() + (out ? " out (no entry on record)" : " in"));
            return out ? new Outcome(true, "exited", "No entry on record: the exit is written down", v, null) : Outcome.in(v);
        });
    }

    // ---- a unit reports a household worker ---------------------------------------------------------------------------------------------------
    public record Reported(UUID flagId, String shortId, boolean entryStopped) {}
    /** A unit the person works for (or the gate team) reports them: security is told now, and each time they come to the gate until security closes it. */
    public Reported report(Caller c, UUID personId, UnitId unit, String reason, String note, boolean stopEntry) {
        if (c.membership() == null) throw new AccessDenied("Sign in to report someone");
        if (!Gate.REPORT_REASONS.contains(reason)) throw new DomainException.RuleViolated("bad-reason", "Pick a reason: " + String.join(", ", Gate.REPORT_REASONS));
        return tx.inTx(() -> {
            Gate.Person p = dir.person(personId).orElseThrow(AccessDenied.NotVisible::new);
            Gate.Link link = dir.links(p.id()).stream().filter((l) -> !"Ended".equals(l.status()) && c.units().contains(l.unit()) && (unit == null || l.unit().equals(unit))).findFirst().orElse(null);
            if (link == null && !GatePolicy.gateOrFm(c)) throw new AccessDenied("You can report only people who work for your unit");
            UnitId u = link != null ? link.unit() : unit;
            String by = link != null ? link.unitNo() : u != null ? dir.unit(u).map(GateDirectory.UnitRef::unitNo).orElse(c.displayName()) : c.displayName();
            Gate.Flag f = store.openReports(p.id()).stream().filter((x) -> Objects.equals(x.unit, u)).findFirst().orElse(null);   // one open report per unit
            if (f == null) {
                f = new Gate.Flag();
                f.id = UUID.randomUUID(); f.type = Gate.REPORTED; f.state = "Open"; f.personName = p.name(); f.personId = p.id(); f.unit = u; f.photo = p.photo();
                f.detail = "Reported by " + by + ": " + reason + (blank(note) == null ? "" : " (" + note.strip() + ")"); f.raisedAt = clock.instant(); f.day = now().toLocalDate();
                store.insert(f);
                events.publish(List.of(new GateEvent("gate.flag.raised", f.id, c.community(), u == null ? null : u.value(), f.type, f.state, clock.instant())));
            }
            boolean stop = stopEntry && link != null;
            if (stop) dir.endLink(p.id(), link.unit());
            audit.write(c, AuditWriter.Action.Create, "gate.flag", f.id, f.shortId, u == null ? null : u.value(), "Reported " + p.name() + " to security: " + reason + (stop ? " (no longer comes to " + by + ")" : ""), List.of());
            return new Reported(f.id, f.shortId, stop);
        });
    }

    // ---- flags, patrols, the console ---------------------------------------------------------------------------------------------------------------
    public Gate.Flag resolveFlag(Caller c, UUID id, long version, String resolution, String note) {
        desk(c);
        if (!Gate.RESOLUTIONS.contains(resolution)) throw new DomainException.RuleViolated("bad-resolution", "Resolve as one of " + Gate.RESOLUTIONS);
        return tx.inTx(() -> {
            Gate.Flag f = store.flag(id).orElseThrow(AccessDenied.NotVisible::new);
            if (f.version != version) throw new DomainException.Conflict("Flag " + f.shortId);
            if ("Closed".equals(f.state)) throw new DomainException.RuleViolated("closed", "This flag is already closed");
            f.state = "Closed"; f.resolution = resolution; f.resolutionNote = blank(note); f.resolvedBy = c.membership() == null ? null : c.membership().value(); f.resolvedAt = clock.instant();
            if (!store.save(f)) throw new DomainException.Conflict("Flag " + f.shortId);
            done(c, "gate.flag.resolved", f.id, f.unit, f.type, f.state, AuditWriter.Action.Update, "gate.flag", f.shortId, "Resolved " + f.type + ": " + resolution);
            return f;
        });
    }
    public record ScanResult(String checkpoint, String round, int done, int total, boolean complete, String place, Integer distM) {}
    /** The phone's GPS at a scan: a position and its accuracy in metres, or why there is none ("denied", "unavailable", "timeout"). */
    public record Position(Double lat, Double lng, Integer accuracy, String error) {
        public boolean known() { return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180; }
    }
    static final int WEAK_GPS_M = 100, SAME_SPOT_M = 10, DEFAULT_RADIUS_M = 40;
    /**
     * A guard scans a checkpoint QR ("GGCP|id|code"): the right code, not too soon after the last scan, counted to the round that is open now.
     * The phone's GPS is kept with the scan and checked against the post's pinned place: further than its radius (plus the GPS's own error, up
     * to 50 m) is "Away from the post" and a flag; location turned off is a flag (once per spell of it); two different posts scanned from the same
     * spot with a good signal is a flag. A weak signal or a post not pinned yet is noted, not flagged. The scan itself always counts.
     */
    public ScanResult scan(Caller c, String text, String note, Position at) {
        desk(c);
        if (c.membership() == null) throw new AccessDenied("Sign in as a guard");
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^GGCP\\|([0-9a-fA-F-]{36})\\|(.+)$").matcher(text == null ? "" : text.strip());
        if (!m.matches()) throw new DomainException.RuleViolated("not-checkpoint", "This is not a checkpoint code");
        return tx.inTx(() -> {
            GateDirectory.Checkpoint cp = dir.checkpoint(UUID.fromString(m.group(1))).filter((x) -> m.group(2).equals(x.code()))
                .orElseThrow(() -> new DomainException.RuleViolated("unknown-checkpoint", "Unknown or out-of-date checkpoint code"));
            if (!cp.active()) throw new DomainException.RuleViolated("inactive", cp.name() + " is not in use");
            ZonedDateTime now = now(); Gate.Settings s = dir.settings();
            UUID guard = c.membership().value();
            Optional<GateStore.Scan> last = store.lastScanOf(guard);
            if (last.isPresent() && s.patrolMinSeconds() > 0 && Duration.between(last.get().at(), now.toInstant()).getSeconds() < s.patrolMinSeconds())
                throw new DomainException.RuleViolated("too-soon", "Too soon after the last scan (" + last.get().checkpointName() + "). Walk to the next post first.");
            GateDirectory.Round live = null;
            for (GateDirectory.Round r : dir.rounds()) {
                if (!r.active() || r.time() == null || (!r.days().isEmpty() && !r.days().contains(Gate.dayOf(now.toLocalDate()))) || !r.checkpointIds().contains(cp.id())) continue;
                ZonedDateTime start = now.toLocalDate().atTime(r.time()).atZone(clock.getZone()), end = start.plusMinutes(r.windowMin() <= 0 ? 60 : r.windowMin());
                if (!now.isBefore(start) && !now.isAfter(end)) { live = r; break; }
            }
            // where the phone was
            boolean known = at != null && at.known();
            Integer acc = known && at.accuracy() != null ? Math.max(0, at.accuracy()) : null, dist = null;
            String place;
            if (known && cp.lat() != null) dist = Gate.metres(at.lat(), at.lng(), cp.lat(), cp.lng());
            if (!known) place = at != null && "denied".equals(at.error()) ? "Location off" : "No location";
            else if (acc != null && acc > WEAK_GPS_M) place = "Weak signal";
            else if (dist == null) place = "Post not mapped";
            else place = dist <= (cp.radiusM() == null ? DEFAULT_RADIUS_M : cp.radiusM()) + Math.min(acc == null ? 0 : acc, 50) ? "At the post" : "Away from the post";
            store.insert(new GateStore.Scan(cp.id(), cp.name(), guard, c.displayName(), now.toInstant(), live == null ? null : live.id(), live == null ? null : live.name(), now.toLocalDate(), blank(note),
                known ? at.lat() : null, known ? at.lng() : null, acc, dist, place));
            dir.beat(guard, "patrol");
            UUID roundId = live == null ? null : live.id();
            String who = c.displayName(), when = now.toLocalTime().withSecond(0).withNano(0).toString();
            if ("Away from the post".equals(place))
                raise(c, Gate.PATROL_LOCATION, who, roundId, cp.name() + " was scanned " + dist + " m from the post (GPS within " + acc + " m) at " + when + ".", now.toLocalDate());
            else if ("Location off".equals(place) && !(last.isPresent() && "Location off".equals(last.get().place()) && Duration.between(last.get().at(), now.toInstant()).toMinutes() < 60))   // once per spell
                raise(c, Gate.PATROL_LOCATION, who, roundId, cp.name() + " was scanned at " + when + " with the phone's location turned off.", now.toLocalDate());
            else if (known && acc != null && acc <= 30 && last.isPresent() && last.get().lat() != null && !cp.id().equals(last.get().checkpointId())
                && (last.get().accM() == null || last.get().accM() <= 30) && Duration.between(last.get().at(), now.toInstant()).toMinutes() < 30) {
                int apart = Gate.metres(at.lat(), at.lng(), last.get().lat(), last.get().lng());
                if (apart <= SAME_SPOT_M) raise(c, Gate.PATROL_LOCATION, who, roundId, last.get().checkpointName() + " and " + cp.name() + " were scanned from the same spot (" + apart + " m apart) at " + when + ".", now.toLocalDate());
            }
            if (live == null) return new ScanResult(cp.name(), null, 0, 0, false, place, dist);
            java.util.Set<UUID> done = new java.util.HashSet<>();
            for (GateStore.Scan x : store.scans(live.id(), now.toLocalDate())) done.add(x.checkpointId());
            done.retainAll(live.checkpointIds());
            return new ScanResult(cp.name(), live.name(), done.size(), live.checkpointIds().size(), done.size() >= live.checkpointIds().size(), place, dist);
        });
    }
    /** The guard console is alive (any tap, or "I'm here"). */
    public void beat(Caller c) { desk(c); if (c.membership() != null) tx.run(() -> dir.beat(c.membership().value(), "activity")); }

    /**
     * The minute job: approvals past their wait apply their fallback (Deny, or "No answer" for the guard to decide), the waiting visits follow;
     * visits past their expected time get one overstay flag; pass visits forgotten for longer than the auto-close time are closed.
     */
    public int sweep(Caller system) {
        return tx.inTx(() -> {
            int n = 0; Instant now = clock.instant(); Gate.Settings s = dir.settings();
            for (Gate.Approval a : store.expired(now)) {
                boolean deny = "Deny".equals(a.fallback);
                a.status = deny ? "Denied" : "No answer"; if (deny) { a.answeredAt = now; a.answeredByName = "Automatic (no answer)"; }
                store.save(a); n++;
                Optional<Gate.Visit> v = store.visit(a.visitId, com.communityos.api.shared.access.Spec.all());
                if (v.isPresent() && v.get().state == VisitState.AWAITING) { v.get().move(deny ? VisitState.DENIED : VisitState.NO_ANSWER); if (deny) v.get().outAt = now; store.save(v.get()); }
                events.publish(List.of(new GateEvent("gate.approval.unanswered", a.id, system.community(), a.unit == null ? null : a.unit.value(), a.kind, a.status, now)));
            }
            for (Gate.Visit v : store.overdue(now.minusSeconds(60L * s.overstayGraceMinutes()))) {
                boolean late = v.expectedUntil != null && Duration.between(v.expectedUntil, now).toMinutes() > 60L * s.autoCloseHours();
                if ("QR / OTP".equals(v.method) && s.autoCloseHours() > 0 && late) { v.move(VisitState.AUTO_CLOSED); v.outAt = now; v.outMethod = "Auto"; store.save(v); n++; continue; }
                if (!store.hasFlag("Overstay", v.id)) { flag(system, "Overstay", v, "Expected out by " + v.expectedUntil.atZone(clock.getZone()).toLocalTime().withNano(0).withSecond(0) + "; still inside."); n++; }
            }
            // a guard clocked in whose console has been quiet for longer than the limit: one flag per quiet spell
            int limit = s.guardSilenceMinutes();
            if (limit > 0) for (GateDirectory.OnDuty g : dir.guardsOnDuty()) {
                Instant last = g.lastBeat() != null && g.lastBeat().isAfter(g.clockIn()) ? g.lastBeat() : g.clockIn();
                long quiet = Duration.between(last, now).toMinutes();
                if (quiet <= limit || store.openFlagSince("Guard silence", g.name(), g.clockIn())) continue;
                raise(system, "Guard silence", g.name(), null, "No activity on the gate console for " + quiet + " min (limit " + limit + "). Clocked in " + hhmm(g.clockIn()) + ".", null);
                n++;
            }
            // a patrol round whose window closed in the last 6 hours, not fully walked although a guard was on duty: one flag per round and day
            ZonedDateTime zn = now(); LocalDate today = zn.toLocalDate();
            for (GateDirectory.Round r : dir.rounds()) {
                if (!r.active() || r.time() == null || r.checkpointIds().isEmpty() || (!r.days().isEmpty() && !r.days().contains(Gate.dayOf(today)))) continue;
                ZonedDateTime start = today.atTime(r.time()).atZone(clock.getZone()), end = start.plusMinutes(r.windowMin() <= 0 ? 60 : r.windowMin());
                if (!zn.isAfter(end) || Duration.between(end, zn).toHours() >= 6) continue;
                if (store.hasRoundFlag(r.id(), today) || !dir.guardOnDutyBetween(start.toInstant(), end.toInstant())) continue;
                Set<UUID> walked = new java.util.HashSet<>();
                for (GateStore.Scan x : store.scans(r.id(), today)) walked.add(x.checkpointId());
                walked.retainAll(r.checkpointIds());
                if (walked.size() >= r.checkpointIds().size()) continue;
                List<String> missing = r.checkpointIds().stream().filter((id) -> !walked.contains(id)).map((id) -> dir.checkpoint(id).map(GateDirectory.Checkpoint::name).orElse("a checkpoint")).toList();
                raise(system, "Missed patrol", r.name(), r.id(), r.name() + " (" + r.time() + ") was " + (walked.isEmpty() ? "not walked" : "only partly walked (" + walked.size() + " of " + r.checkpointIds().size() + ")")
                    + ". Not scanned: " + String.join(", ", missing) + ".", today);
                n++;
            }
            return n;
        });
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------------------------------------
    private Gate.Visit visit(Caller c, String kind, String name, UnitId unit, String gate, String method, VisitState state) {
        Gate.Visit v = new Gate.Visit();
        v.id = UUID.randomUUID(); v.kind = kind; v.name = name; v.unit = unit; v.gate = blank(gate) == null ? "Main gate" : gate.strip(); v.method = method; v.state = state;
        v.inAt = state == VisitState.INSIDE ? clock.instant() : null; v.outAt = state == VisitState.REFUSED ? clock.instant() : null;
        v.expectedUntil = state == VisitState.INSIDE ? expected(kind, null, null) : null;
        v.verifiedBy = c.membership() == null ? null : c.membership().value();
        return v;
    }
    /** When a visit should be over: a household link's end time, a work order's end + 30 min, else the community's minutes for the kind. */
    private Instant expected(String kind, LocalTime linkTo, LocalTime orderTo) {
        if ("Resident vehicle".equals(kind)) return null;
        ZonedDateTime now = now();
        if (linkTo != null) return now.toLocalDate().atTime(linkTo).atZone(clock.getZone()).toInstant();
        if (orderTo != null) return now.toLocalDate().atTime(orderTo).atZone(clock.getZone()).plusMinutes(30).toInstant();
        int m = dir.settings().minutesFor(kind);
        return m <= 0 ? null : now.plusMinutes(m).toInstant();
    }
    private void flag(Caller c, String type, Gate.Visit v, String detail) {
        Gate.Flag f = new Gate.Flag();
        f.id = UUID.randomUUID(); f.type = type; f.state = "Open"; f.gate = v.gate; f.personName = v.name; f.unit = v.unit; f.detail = detail; f.raisedAt = clock.instant();
        f.visitId = v.id; f.personId = v.personId; f.photo = v.photo; f.day = now().toLocalDate();
        store.insert(f);
        events.publish(List.of(new GateEvent("gate.flag.raised", f.id, c.community(), v.unit == null ? null : v.unit.value(), type, f.state, clock.instant())));
    }
    /** A flag that is not about one visit (a quiet console, a missed round). */
    private void raise(Caller c, String type, String personName, UUID roundId, String detail, LocalDate day) {
        Gate.Flag f = new Gate.Flag();
        f.id = UUID.randomUUID(); f.type = type; f.state = "Open"; f.personName = personName; f.roundId = roundId; f.detail = detail; f.raisedAt = clock.instant(); f.day = day != null ? day : now().toLocalDate();
        store.insert(f);
        events.publish(List.of(new GateEvent("gate.flag.raised", f.id, c.community(), null, type, f.state, clock.instant())));
    }
    private String hhmm(Instant t) { return t.atZone(clock.getZone()).toLocalTime().withSecond(0).withNano(0).toString(); }
    static String nz(String s, String d) { return s == null || s.isBlank() ? d : s; }
    private Gate.Visit changeVisit(Caller c, UUID id, long version, java.util.function.Function<Gate.Visit, String> work, String topic) {
        return tx.inTx(() -> {
            Gate.Visit v = store.visit(id, com.communityos.api.shared.access.Spec.all()).orElseThrow(AccessDenied.NotVisible::new);
            if (v.version != version) throw new DomainException.Conflict("Visit " + v.shortId);
            String what = work.apply(v);
            if (!store.save(v)) throw new DomainException.Conflict("Visit " + v.shortId);
            done(c, topic, v.id, v.unit, v.kind, v.state.label, AuditWriter.Action.Update, "gate.visit", v.shortId, what);
            return v;
        });
    }
    private void done(Caller c, String topic, UUID id, UnitId unit, String kind, String state, AuditWriter.Action a, String entity, String shortId, String summary) {
        events.publish(List.of(new GateEvent(topic, id, c.community(), unit == null ? null : unit.value(), kind, state, clock.instant())));
        audit.write(c, a, entity, id, shortId, unit == null ? null : unit.value(), summary, List.of());
    }
    static String norm(String plate) { return plate == null ? "" : plate.replaceAll("\\s+", "").toUpperCase(); }
    static String blank(String s) { return s == null || s.isBlank() ? null : s.strip(); }
    static <T> T or(T a, Supplier<T> b) { return a != null ? a : b.get(); }
    static List<String> list(List<String> l) { return l == null ? new ArrayList<>() : l; }
}
