package com.communityos.api.cultural.application;

import com.communityos.api.billing.application.BillingDesk;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.cultural.application.port.CulturalStore;
import com.communityos.api.cultural.domain.Cultural;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * Donations to an event. A resident pledges for their own unit (optionally reserving a fixed offering slot); the committee records what it
 * receives. A pledge becomes Received exactly once: at the office (cash, cheque, transfer ...), or online (a prepayment the donation claims).
 * Then it gets the event's next receipt number and the money is in the books - Dr receivable / Cr 4400 Donations, settled by the payment
 * (a visitor without a unit: Dr bank / Cr 4400 directly). In-kind gifts get a receipt but no money moves. A received donation is not changed.
 */
public final class DonationService {
    public record DonationEvent(String topic, UUID aggregateId, CommunityId communityId, UUID eventId, UUID unitId, String receiptNo, BigDecimal amount, Instant occurredAt) implements DomainEvent {}
    /** A pledge or a donation as written; the status, receipt number and who received it are the server's. */
    public record Pledge(UUID eventId, String donor, UUID unitId, String kind, String towards, BigDecimal amount, LocalDate date, String mode, String reference, boolean anonymous,
                         String note, String phone, String members, String sankalpam, UUID offeringId) {}

    private final CulturalStore store; private final BillingDesk desk; private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public DonationService(CulturalStore store, BillingDesk desk, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.desk = desk; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    public List<Cultural.Donation> list(Caller c, UUID eventId) { return store.donations(CulturalPolicy.donations(c), eventId); }
    public Cultural.Donation get(Caller c, UUID id) { return store.donation(id, CulturalPolicy.donations(c)).orElseThrow(AccessDenied.NotVisible::new); }

    /** A resident's pledge for their unit (reserving a fixed slot when it names one). */
    public Cultural.Donation pledge(Caller c, Pledge p) {
        if (!c.isResident() && !CulturalPolicy.manager(c)) throw new AccessDenied("Residents pledge; the committee records donations");
        return tx.inTx(() -> {
            Cultural.Event ev = openEvent(c, p.eventId());
            UUID unit = p.unitId();
            if (c.isResident()) {
                if (unit == null && c.units().size() == 1) unit = c.units().iterator().next().value();
                UUID u = unit;
                if (u == null || c.units().stream().noneMatch((x) -> x.value().equals(u))) throw new AccessDenied("Pledge for your own unit");
            }
            Cultural.Donation d = apply(new Cultural.Donation(), p, unit, c);
            d.status = "Pledged"; d.receiptNo = null; d.pledgedById = c.membership() == null ? null : c.membership().value();
            d.check();
            CulturalStore.Offering o = p.offeringId() == null ? null : offering(ev, p.offeringId());
            if (o != null) { d.towards = "Seva offering"; d.kind = "Sponsorship"; d.note = d.note == null ? o.title() + (o.day() == null ? "" : " · " + o.day()) : d.note; }
            store.insert(d);
            if (o != null && "Fixed slot".equals(o.kind()) && !store.reserve(o.id(), d.id, d.donor, unit)) throw new DomainException.RuleViolated("taken", o.title() + " is already reserved");
            done(c, d, "cultural.donation.pledged", AuditWriter.Action.Create, "Pledged " + d.amount.toPlainString() + " to " + ev.name());
            return store.donation(d.id, Spec.all()).orElseThrow();
        });
    }
    /** The committee records a donation: received now (receipt and books), or as a pledge to collect later. */
    public Cultural.Donation record(Caller c, Pledge p, boolean received) {
        requireManager(c);
        return tx.inTx(() -> {
            Cultural.Event ev = openEvent(c, p.eventId());
            Cultural.Donation d = apply(new Cultural.Donation(), p, p.unitId(), c);
            d.check();
            CulturalStore.Offering o = p.offeringId() == null ? null : offering(ev, p.offeringId());
            store.insert(d);
            if (o != null && "Fixed slot".equals(o.kind()) && !store.reserve(o.id(), d.id, d.donor, d.unitId)) throw new DomainException.RuleViolated("taken", o.title() + " is already reserved");
            if (received) receiveNow(c, ev, d, p.mode(), p.reference(), null);
            done(c, d, received ? "cultural.donation.received" : "cultural.donation.pledged", AuditWriter.Action.Create, (received ? "Received " : "Pledged ") + d.amount.toPlainString());
            return store.donation(d.id, Spec.all()).orElseThrow();
        });
    }
    /** A pledge changed by its unit (or the committee) while it is still a pledge. */
    public Cultural.Donation change(Caller c, UUID id, long version, Pledge p) {
        return tx.inTx(() -> {
            Cultural.Donation d = mine(c, id, version);
            if (d.received()) throw new DomainException.RuleViolated("received", "A received donation is not changed - the committee can record a correction");
            UUID offering = d.offeringId;
            apply(d, p, d.unitId, c); d.offeringId = offering; d.eventId = d.eventId;
            d.check();
            if (!store.update(d)) throw new DomainException.Conflict("Donation " + d.shortId);
            done(c, d, "cultural.donation.changed", AuditWriter.Action.Update, "Pledge changed to " + d.amount.toPlainString());
            return store.donation(id, Spec.all()).orElseThrow();
        });
    }
    /** Withdraw a pledge (its unit or the committee); a reserved slot becomes free. */
    public void withdraw(Caller c, UUID id, long version) {
        tx.run(() -> {
            Cultural.Donation d = mine(c, id, version);
            if (d.received()) throw new DomainException.RuleViolated("received", "A received donation cannot be withdrawn - contact the committee");
            store.release(d.id);
            if (!store.delete(id, version)) throw new DomainException.Conflict("Donation " + d.shortId);
            audit.write(c, AuditWriter.Action.Delete, "cultural.donation", d.id, d.shortId, d.unitId, "Pledge withdrawn", List.of());
        });
    }
    /** The committee marks a pledge received at the office. */
    public Cultural.Donation receive(Caller c, UUID id, long version, String mode, String reference) {
        requireManager(c);
        return tx.inTx(() -> {
            Cultural.Donation d = current(id, version);
            if (d.received()) throw new DomainException.RuleViolated("received", "Already received - receipt " + d.receiptNo);
            Cultural.Event ev = store.event(d.eventId, true).orElseThrow();
            receiveNow(c, ev, d, mode, reference, null);
            done(c, d, "cultural.donation.received", AuditWriter.Action.Update, "Received " + d.amount.toPlainString() + " - receipt " + d.receiptNo);
            return store.donation(id, Spec.all()).orElseThrow();
        });
    }
    /** The unit paid its pledge online: the prepayment (made for a donation, by this unit) is claimed. */
    public Cultural.Donation paidOnline(Caller c, UUID id, long version, UUID prepaymentId) {
        return tx.inTx(() -> {
            Cultural.Donation d = mine(c, id, version);
            if (d.received()) throw new DomainException.RuleViolated("received", "Already received - receipt " + d.receiptNo);
            if (d.unitId == null) throw new DomainException.RuleViolated("no-unit", "Only a unit's pledge is paid online");
            Cultural.Event ev = store.event(d.eventId, true).orElseThrow();
            receiveNow(c, ev, d, "Online", null, prepaymentId);
            done(c, d, "cultural.donation.received", AuditWriter.Action.Update, "Paid online " + d.amount.toPlainString() + " - receipt " + d.receiptNo);
            return store.donation(id, Spec.all()).orElseThrow();
        });
    }

    // ---- internals -----------------------------------------------------------------------------------------------------------------------------
    private void receiveNow(Caller c, Cultural.Event ev, Cultural.Donation d, String mode, String reference, UUID prepaymentId) {
        boolean inKind = "In-kind".equals(d.kind);
        if (prepaymentId == null && !inKind && (mode == null || !Cultural.MODES.contains(mode))) throw new DomainException.RuleViolated("bad-mode", "Received by: " + String.join(", ", Cultural.MODES));
        Instant now = clock.instant();
        LocalDate day = now.atZone(clock.getZone()).toLocalDate();
        String code = ev.receiptCode();
        d.receiptNo = code + "-" + String.format(Locale.ROOT, "%04d", store.lastReceipt(code) + 1);
        d.status = "Received"; d.receivedAt = now; d.receivedById = c.membership() == null ? null : c.membership().value();
        d.mode = prepaymentId != null ? "Online" : inKind ? "In-kind" : mode; d.reference = reference == null || reference.isBlank() ? d.reference : reference.strip();
        if (d.date == null) d.date = day;
        if (!store.update(d)) throw new DomainException.Conflict("Donation " + d.shortId);
        if (inKind) return;                                                  // a gift in kind: a receipt, no money in the books
        Money amt = new Money(d.amount);
        String memo = "Donation " + d.receiptNo + " · " + ev.name();
        if (d.unitId == null) {                                              // a visitor at the office: straight to the bank
            desk.post(new Journal.Entry(day, memo, "donation", d.id, List.of(Journal.Line.debit("1000", null, amt, "Donation received"), Journal.Line.credit("4400", null, amt, "Donations"))));
            return;
        }
        desk.post(new Journal.Entry(day, memo, "donation", d.id, List.of(Journal.Line.debit("1100", d.unitId, amt, "Donation pledged"), Journal.Line.credit("4400", d.unitId, amt, "Donations"))));
        UnitId unit = new UnitId(d.unitId);
        if (prepaymentId != null) { desk.usePrepayment(c, unit, prepaymentId, "donation", amt, "donation", d.id, memo); d.paymentId = prepaymentId; }
        else { var r = desk.receive(c, unit, amt, mode, d.reference, "donation", d.id, amt); d.paymentId = r.id().value(); }
        if (!store.update(d)) throw new DomainException.Conflict("Donation " + d.shortId);
    }
    private Cultural.Event openEvent(Caller c, UUID eventId) {
        if (eventId == null) throw new DomainException.RuleViolated("event-required", "Which event?");
        Cultural.Event ev = store.event(eventId, true).orElseThrow(AccessDenied.NotVisible::new);
        if (c.isResident() && !ev.published()) throw new AccessDenied.NotVisible();
        if (!List.of("Planning", "Open").contains(ev.status())) throw new DomainException.RuleViolated("event-closed", ev.name() + " is " + ev.status().toLowerCase(Locale.ROOT));
        return ev;
    }
    private CulturalStore.Offering offering(Cultural.Event ev, UUID id) {
        CulturalStore.Offering o = store.offering(id).filter((x) -> x.eventId().equals(ev.id())).orElseThrow(() -> new DomainException.RuleViolated("bad-offering", "That offering is not part of this event"));
        if ("Fixed slot".equals(o.kind()) && o.donationId() != null) throw new DomainException.RuleViolated("taken", o.title() + " is already reserved");
        return o;
    }
    private Cultural.Donation current(UUID id, long version) {
        Cultural.Donation d = store.donation(id, Spec.all()).orElseThrow(AccessDenied.NotVisible::new);
        if (d.version != version) throw new DomainException.Conflict("Donation " + d.shortId);
        return d;
    }
    /** Its unit's (or the committee's) donation. */
    private Cultural.Donation mine(Caller c, UUID id, long version) {
        Cultural.Donation d = store.donation(id, CulturalPolicy.manager(c) ? Spec.all() : CulturalPolicy.donations(c)).orElseThrow(AccessDenied.NotVisible::new);
        if (!CulturalPolicy.manager(c) && !c.isResident()) throw new AccessDenied("Only its unit or the committee changes a pledge");
        if (d.version != version) throw new DomainException.Conflict("Donation " + d.shortId);
        return d;
    }
    static Cultural.Donation apply(Cultural.Donation d, Pledge p, UUID unit, Caller c) {
        d.eventId = d.eventId == null ? p.eventId() : d.eventId;
        d.donor = p.donor() == null || p.donor().isBlank() ? (c.isResident() ? c.displayName() : null) : p.donor();
        d.unitId = unit; d.kind = p.kind() == null ? "Donation" : p.kind(); d.towards = p.towards() == null ? "General" : p.towards(); d.amount = p.amount(); d.date = p.date();
        d.mode = p.mode(); d.reference = blank(p.reference()); d.anonymous = p.anonymous(); d.note = blank(p.note()); d.phone = blank(p.phone()); d.members = blank(p.members());
        d.sankalpam = blank(p.sankalpam()); d.offeringId = p.offeringId();
        return d;
    }
    private void done(Caller c, Cultural.Donation d, String topic, AuditWriter.Action a, String summary) {
        events.publish(List.of(new DonationEvent(topic, d.id, c.community(), d.eventId, d.unitId, d.receiptNo, d.amount, clock.instant())));
        audit.write(c, a, "cultural.donation", d.id, d.shortId, d.unitId, summary, List.of());
    }
    static String blank(String s) { return s == null || s.isBlank() ? null : s.strip(); }
    static void requireManager(Caller c) { if (!CulturalPolicy.manager(c)) throw new AccessDenied("Recording donations needs the cultural committee's permission"); }
}
