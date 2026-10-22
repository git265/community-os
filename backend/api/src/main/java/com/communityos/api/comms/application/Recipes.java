package com.communityos.api.comms.application;

import com.communityos.api.amenity.domain.BookingEvents;
import com.communityos.api.billing.domain.BillingEvents;
import com.communityos.api.comms.application.port.Facts;
import com.communityos.api.comms.application.port.Facts.Fact;
import com.communityos.api.comms.domain.Comms.Message;
import com.communityos.api.comms.domain.Comms.To;
import com.communityos.api.gate.application.GateService.GateEvent;
import com.communityos.api.maintenance.application.QuotationService;
import com.communityos.api.maintenance.domain.TicketEvents;
import com.communityos.api.shared.domain.DomainEvent;
import java.math.BigDecimal;
import java.text.NumberFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;

/**
 * What to tell whom when something happens - one recipe per kind of event. Pure: the facts (a ticket's number, a visitor's name) come from
 * the Facts port, and the inbox decides the rest (one row per person, their channels, never the person who did it).
 * Events with no recipe tell nobody.
 */
public final class Recipes {
    private Recipes() {}
    /** The team told about new requests and gate flags (by role code). */
    static final String[] HELPDESK = {"facility_manager", "helpdesk"};
    /** Everyone who lives here (published meetings). */
    static final String[] RESIDENTS = {"owner", "resident"};
    static final String[] SECURITY = {"committee_security", "facility_manager"};

    public static List<Message> of(DomainEvent e, Facts facts) {
        List<Message> out = new ArrayList<>();
        switch (e) {
            case TicketEvents.TicketRaised r -> ticket(facts, r.ticketId()).ifPresent((f) -> out.add(new Message("ticket_new", "community", "New request · " + f.number(),
                f.title() + " — " + (f.unitNo() == null ? "common area" : f.unitNo()), ticketLink(f), r.ticketId(),
                "Community".equals(r.scope()) ? To.roles("facility_manager", "helpdesk", "handyman_mep") : To.roles(HELPDESK))));
            case TicketEvents.TicketAssigned a -> ticket(facts, a.ticketId()).ifPresent((f) -> out.add(new Message("ticket_assigned", "assigned", "New task assigned · " + f.number(),
                f.title() + " was assigned to you.", ticketLink(f), a.ticketId(), To.member(a.assigneeId() == null ? null : a.assigneeId().value()))));
            case TicketEvents.TicketStatusChanged s -> ticket(facts, s.ticketId()).ifPresent((f) -> out.add(new Message("ticket_status", "status", f.number() + " is now " + s.to(),
                f.title() + ": " + s.from() + " → " + s.to() + ".", ticketLink(f), s.ticketId(), To.member(f.owner()))));
            case TicketEvents.CommentAdded c -> ticket(facts, c.ticketId()).ifPresent((f) -> out.add(new Message("ticket_chat", "chat", "New message · " + f.number(),
                "There is a new message on " + f.title() + ".", ticketLink(f), c.ticketId(),
                "Internal".equals(c.visibility()) ? To.member(f.other()) : To.member(f.owner()).and(To.member(f.other())))));
            case QuotationService.Changed q when "Approved".equals(q.status()) || "Rejected".equals(q.status()) ->
                ticket(facts, q.ticketId()).ifPresent((f) -> out.add(new Message("ticket_decision", "decision", f.number() + ": " + q.kind().toLowerCase(Locale.ROOT) + " " + q.status().toLowerCase(Locale.ROOT),
                    "The " + q.kind().toLowerCase(Locale.ROOT) + " on " + f.title() + " was " + q.status().toLowerCase(Locale.ROOT) + ".", ticketLink(f), q.ticketId(),
                    To.member(f.owner()).and(To.member(f.other())))));
            case BillingEvents.DueRaised d -> out.add(new Message("bill", "bill", "New bill · " + rupees(d.amount().amount().add(d.tax() == null ? BigDecimal.ZERO : d.tax().amount())),
                "A bill for " + (d.billedMonth() == null ? "your unit" : d.billedMonth().getMonth().getDisplayName(java.time.format.TextStyle.SHORT, Locale.ENGLISH) + " " + d.billedMonth().getYear())
                    + " is due on " + d.dueDate() + ".", "#/billing", d.dueId().value(), To.unit(d.unitId() == null ? null : d.unitId().value())));
            case BillingEvents.PaymentRecorded p when p.unitId() != null -> out.add(new Message("bill", "payment", "Payment received · " + p.receiptNo(),
                rupees(p.amount().amount()) + " was received" + (p.toCredit() != null && p.toCredit().amount().signum() > 0 ? " (" + rupees(p.toCredit().amount()) + " kept as credit)" : "") + ".",
                "#/billing", p.paymentId().value(), To.unit(p.unitId().value())));
            case BillingEvents.PaymentOrderFailed f when f.unitId() != null -> out.add(new Message("bill", "payment", "Payment not completed",
                "Your online payment did not go through" + (f.reason() == null ? "" : " (" + f.reason() + ")") + ". Nothing was taken; if money left your account, it is recorded or returned by the bank.",
                "#/billing", f.orderId().value(), To.unit(f.unitId().value())));
            case BillingEvents.DueCancelled d when d.unitId() != null -> out.add(new Message("bill", "bill", "Bill cancelled",
                "A bill of " + rupees(d.amount().amount().add(d.tax() == null ? BigDecimal.ZERO : d.tax().amount())) + " was cancelled" + (d.reason() == null ? "" : ": " + d.reason()) + ".", "#/billing", d.dueId().value(), To.unit(d.unitId().value())));
            case BillingEvents.DueWaived d when d.unitId() != null -> out.add(new Message("bill", "bill", "Bill waived · " + rupees(d.waived().amount()),
                rupees(d.waived().amount()) + " of a bill was waived" + (d.reason() == null ? "" : ": " + d.reason()) + ".", "#/billing", d.dueId().value(), To.unit(d.unitId().value())));
            case com.communityos.api.billing.application.PaymentReconciler.IssueFound i -> out.add(new Message("money_check", "reconciliation", "Money check: " + i.kind().replace('-', ' '),
                i.detail(), "#/billing", i.aggregateId(), To.roles("treasurer")));
            case BookingEvents b when b.topic().endsWith(".created") || b.topic().endsWith(".cancelled") ->
                facts.of(Facts.Kind.BOOKING, b.aggregateId()).ifPresent((f) -> out.add(new Message("amenity_booking", "booking",
                    (b.topic().endsWith(".created") ? "Booked: " : "Booking cancelled: ") + f.title() + " on " + b.date(),
                    f.number() + (f.extra() == null ? "" : " · " + f.extra()) + " · " + b.status() + (b.paymentStatus() == null ? "" : ", " + b.paymentStatus()), "#/amenities", b.aggregateId(),
                    To.unit(f.unitId()))));
            case GateEvent g -> gate(g, facts).ifPresent(out::add);
            case com.communityos.api.cultural.application.DonationService.DonationEvent d when d.topic().endsWith(".received") && d.unitId() != null ->
                out.add(new Message("cultural", "donation", "Receipt " + d.receiptNo(), "Thank you! " + rupees(d.amount()) + " was received - receipt " + d.receiptNo() + ".", "#/cultural/donation/" + d.aggregateId(),
                    d.aggregateId(), To.unit(d.unitId())));
            case com.communityos.api.cultural.application.ExpenseService.ExpenseEvent x -> expense(x).ifPresent(out::add);
            case com.communityos.api.finance.application.ReleaseService.ReleaseEvent r when r.topic().endsWith(".raised") || r.topic().endsWith(".resubmitted") ->
                out.add(new Message("approval", "release", "Release to approve · " + rupees(r.amount()), "A release of " + rupees(r.amount()) + " waits for approval.", "#/billing", r.aggregateId(),
                    To.roles("president", "general_secretary", "treasurer")));
            case com.communityos.api.finance.application.ReleaseService.ReleaseEvent r when r.topic().endsWith(".decided") && List.of("Approved", "Rejected").contains(r.status()) ->
                out.add(new Message("payment_made", "release", "Release " + r.status().toLowerCase(Locale.ROOT) + " · " + rupees(r.amount()), "Your release of " + rupees(r.amount()) + " was "
                    + r.status().toLowerCase(Locale.ROOT) + ".", "#/billing", r.aggregateId(), To.member(r.raisedBy())));
            case com.communityos.api.finance.application.ReleaseService.ReleaseEvent r when r.topic().endsWith(".paid") ->
                out.add(new Message("payment_made", "release", "Release paid · " + rupees(r.amount()), "The release of " + rupees(r.amount()) + " was paid.", "#/billing", r.aggregateId(), To.member(r.raisedBy())));
            case com.communityos.api.assets.application.AssetService.StockEvent x ->
                out.add(new Message("stock_low", "stock", "Low stock \u00b7 " + x.item(), x.balance().stripTrailingZeros().toPlainString() + " " + x.uom() + " left (minimum "
                    + (x.minStock() == null ? "-" : x.minStock().stripTrailingZeros().toPlainString()) + ").", "#/assets", x.aggregateId(), To.roles("facility_manager", "handyman_mep")));
            case com.communityos.api.governance.application.MeetingService.MeetingEvent m ->
                out.add(new Message("meeting", "meeting", m.title(), m.detail(), "#/governance", m.aggregateId(), To.roles(RESIDENTS)));
            case com.communityos.api.governance.application.BallotService.BallotEvent b when b.topic().endsWith(".opened") ->
                out.add(new Message("ballot", "ballot", "Voting is open \u00b7 " + b.title(), b.detail(), "#/communications", b.aggregateId(), To.roles("owner")));
            case com.communityos.api.governance.application.BallotService.BallotEvent b when b.topic().endsWith(".closed") ->
                out.add(new Message("ballot_result", "ballot", "Voting closed \u00b7 " + b.title(), b.detail(), "#/communications", b.aggregateId(), To.roles("owner")));
            default -> { }
        }
        return out;
    }

    static Optional<Message> gate(GateEvent g, Facts facts) {
        UUID unit = g.unitId();
        String topic = g.topic();
        return switch (topic) {
            case "gate.approval.requested" -> facts.of(Facts.Kind.GATE_APPROVAL, g.aggregateId()).map((f) -> new Message("gate_approval", "gate", "At the gate: " + f.title(),
                kindOf(g) + " for " + nz(f.unitNo(), "your unit") + (f.extra() == null ? "" : " at " + f.extra()) + ". Approve or deny.", "#/mygate", g.aggregateId(), To.unit(unit)));
            case "gate.approval.unanswered" -> facts.of(Facts.Kind.GATE_APPROVAL, g.aggregateId()).map((f) -> new Message("gate_approval", "gate", "No answer for " + f.title(),
                "Nobody answered in time, so the gate applied your setting: " + nz(g.state(), "held") + ".", "#/mygate", g.aggregateId(), To.unit(unit)));
            case "gate.guest.arrived", "gate.staff.arrived", "gate.crew.arrived", "gate.delivery.arrived", "gate.delivery.left", "gate.visit.exited" -> {
                String event = switch (topic) {
                    case "gate.staff.arrived" -> "gate_staff_inout"; case "gate.crew.arrived" -> "gate_crew_inout";
                    case "gate.delivery.arrived", "gate.delivery.left" -> "gate_delivery"; case "gate.visit.exited" -> "gate_guest_exit"; default -> "gate_guest_arrived";
                };
                if ("gate.visit.exited".equals(topic) && !"Guest".equals(g.kind())) yield Optional.empty();
                yield facts.of(Facts.Kind.GATE_VISIT, g.aggregateId()).map((f) -> new Message(event, "gate",
                    switch (topic) { case "gate.delivery.left" -> "Delivery left at the gate: " + f.title(); case "gate.visit.exited" -> f.title() + " has left"; default -> f.title() + " has arrived"; },
                    kindOf(g) + (f.extra() == null ? "" : " · " + f.extra()), "#/mygate", g.aggregateId(), To.unit(unit)));
            }
            case "gate.flag.raised" -> facts.of(Facts.Kind.GATE_FLAG, g.aggregateId()).map((f) -> new Message(flagEvent(g.kind()), "gate", "Gate flag: " + g.kind(),
                nz(f.title(), "") + (f.extra() == null ? "" : (f.title() == null ? "" : " — ") + f.extra()), "#/security", g.aggregateId(), To.roles(SECURITY)));
            case "gate.visit.override" -> facts.of(Facts.Kind.GATE_VISIT, g.aggregateId()).map((f) -> new Message("gate_override", "gate", "Guard override: " + f.title(),
                "The gate was opened by hand" + (f.extra() == null ? "" : " · " + f.extra()) + ".", "#/security", g.aggregateId(), To.roles("committee_security")));
            default -> Optional.empty();
        };
    }
    static Optional<Message> expense(com.communityos.api.cultural.application.ExpenseService.ExpenseEvent x) {
        String what = rupees(x.amount()) + " for " + x.item();
        if ("ec".equals(x.waitingFor()) && (x.topic().endsWith(".raised") || x.topic().endsWith(".resubmitted")))
            return Optional.of(new Message("approval", "expense", "Expense to approve · " + x.item(), what + " waits for the EC's approval.", "#/cultural/expense/" + x.aggregateId(), x.aggregateId(),
                To.roles("president", "general_secretary", "treasurer", "committee_cultural")));
        if ("final".equals(x.waitingFor()) && x.topic().endsWith(".decided"))
            return Optional.of(new Message("approval", "expense", "Final approval needed · " + x.item(), what + " is approved by the EC and needs the final approval.", "#/cultural/expense/" + x.aggregateId(), x.aggregateId(),
                To.roles("treasurer", "president")));
        if (x.topic().endsWith(".decided") && List.of("Approved", "Rejected").contains(x.status()))
            return Optional.of(new Message("cultural", "expense", "Expense " + x.status().toLowerCase(Locale.ROOT) + " · " + x.item(), what + " was " + x.status().toLowerCase(Locale.ROOT) + ".",
                "#/cultural/expense/" + x.aggregateId(), x.aggregateId(), To.member(x.raisedBy())));
        return Optional.empty();
    }
    static String flagEvent(String type) {
        if (type == null) return "gate_ghost";
        if (type.contains("Overstay") || type.contains("No exit")) return "gate_overstay";
        if (type.contains("Blocked")) return "gate_blocked";
        if (type.contains("Manual") || type.contains("override")) return "gate_override";
        return "gate_ghost";
    }
    static String kindOf(GateEvent g) { return g.kind() == null ? "Visitor" : g.kind(); }
    static Optional<Fact> ticket(Facts facts, UUID id) { return facts.of(Facts.Kind.TICKET, id); }
    static String ticketLink(Fact f) { return "#/ticket/" + f.number(); }
    static String nz(String s, String dflt) { return s == null || s.isBlank() ? dflt : s; }
    static String rupees(BigDecimal v) { NumberFormat f = NumberFormat.getNumberInstance(Locale.forLanguageTag("en-IN")); f.setMaximumFractionDigits(2); f.setMinimumFractionDigits(0); return "₹" + f.format(v); }
}
