package com.communityos.api.demo;

import static com.communityos.api.demo.DemoData.date;
import static com.communityos.api.demo.DemoData.dec;
import static com.communityos.api.demo.DemoData.instant;
import static com.communityos.api.demo.DemoData.phone;
import static com.communityos.api.demo.DemoData.text;
import static com.communityos.api.demo.DemoData.time;

import com.communityos.api.amenity.application.BookingService;
import com.communityos.api.amenity.domain.Booking;
import com.communityos.api.billing.application.CounterSettlement;
import com.communityos.api.billing.application.DueService;
import com.communityos.api.billing.application.PaymentService;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.comms.application.BroadcastService;
import com.communityos.api.comms.application.ForumService;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.cultural.application.DonationService;
import com.communityos.api.cultural.application.ExpenseService;
import com.communityos.api.cultural.domain.Cultural;
import com.communityos.api.docs.application.DocumentService;
import com.communityos.api.docs.application.FileService;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.gate.application.GateService;
import com.communityos.api.gate.domain.Gate;
import com.communityos.api.governance.application.MeetingService;
import com.communityos.api.governance.domain.Governance;
import com.communityos.api.maintenance.application.QuotationService;
import com.communityos.api.maintenance.application.TicketService;
import com.communityos.api.maintenance.domain.Quotation;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.maintenance.domain.TicketStatus;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.vendor.application.DirectoryService;
import com.communityos.api.vendor.domain.Directory;
import com.communityos.api.workforce.application.AttendanceService;
import com.communityos.api.workforce.domain.Attendance;
import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** The sample records that are not plain registers: each goes through its own service, step by step, as it happened. */
final class DemoFlows {
    /** Collections the v2 server does not keep, or works out itself - with the reason the load result gives. */
    static final Map<String, String> NOT_ON_V2 = Map.ofEntries(
        Map.entry("blocks", "blocks are set up with the units"), Map.entry("facilities", "not on the v2 back end yet"), Map.entry("billingTemplates", "not on the v2 back end yet"),
        Map.entry("taxSettings", "not on the v2 back end yet"), Map.entry("taxComponents", "not on the v2 back end yet"), Map.entry("paymentRouting", "not on the v2 back end yet"),
        Map.entry("readings", "meter readings are not on the v2 back end yet (the bills are)"), Map.entry("utilityTypes", "not on the v2 back end yet"),
        Map.entry("unitCredits", "a unit's credit is made by the server (an overpayment or a refund)"), Map.entry("ecRoles", "the committee is the members' roles on v2"),
        Map.entry("subcommittees", "the committees are the members' roles on v2"), Map.entry("approvals", "approvals are made on the tickets and expenses themselves"),
        Map.entry("workforce", "the teams on duty are worked out from attendance"), Map.entry("gateApprovals", "made at the gate when the guard asks (see gateVisits)"),
        Map.entry("gateFlags", "raised by the gate's own checks"));
    /** References that point back at a row the server makes later (so they do not order the load). */
    static final Set<String> BACK_REFS = Set.of("tickets.selectedQuotationId", "culturalOfferings.donationId", "gateApprovals.visitId", "gateVisits.approvalId", "dues.readingId");
    private static final Set<String> HANDLED = Set.of("dues", "tickets", "ticketComments", "quotations", "amenities", "gatePasses", "gateVisits", "broadcasts", "forum", "forumPosts",
        "documents", "culturalDonations", "culturalExpenses", "ledger", "bankTxns", "meetings", "serviceContacts", "contactReviews", "attendance", "infraLog");

    private final DemoData d;
    private final List<JsonNode> clockedIn = new ArrayList<>();
    DemoFlows(DemoData d) { this.d = d; }

    boolean handles(String c) { return HANDLED.contains(c) || NOT_ON_V2.containsKey(c); }
    /** Collections a flow needs first, beyond the rows it points at. */
    Set<String> after(String c) {
        return switch (c) {
            case "tickets" -> Set.of("taskTypes", "categoryMap", "approverSettings", "equipment");
            case "quotations" -> Set.of("tickets", "vendors", "approvalPolicies", "financeSettings");
            case "amenities" -> Set.of("amenityTypes", "amenityItems", "amenitySettings", "dues");
            case "gateVisits" -> Set.of("gatePasses", "gatePeople", "gateLinks", "gateWorkOrders", "gateSettings", "gateVillaRules");
            case "culturalDonations", "culturalExpenses" -> Set.of("culturalEvents", "culturalOfferings", "funds", "approvalPolicies");
            case "ledger" -> Set.of("bankAccounts", "funds", "financeSettings", "dues", "amenities", "culturalExpenses", "culturalDonations");
            case "bankTxns" -> Set.of("bankAccounts", "ledger");
            case "attendance" -> Set.of("attendanceSettings", "siteHolidays");
            case "infraLog" -> Set.of("equipment", "tickets");
            case "dues" -> Set.of("financeSettings");
            default -> Set.of();
        };
    }

    void load(String c, JsonNode list) {
        if (NOT_ON_V2.containsKey(c)) { d.skipped.put(c, NOT_ON_V2.get(c)); return; }
        switch (c) {
            case "dues" -> list.forEach(this::due);
            case "tickets" -> list.forEach(this::ticket);
            case "ticketComments" -> list.forEach(this::ticketComment);
            case "quotations" -> { list.forEach(this::quotation); selections(); }
            case "amenities" -> list.forEach(this::booking);
            case "gatePasses" -> list.forEach(this::pass);
            case "gateVisits" -> list.forEach(this::visit);
            case "broadcasts" -> list.forEach(this::broadcast);
            case "forum" -> list.forEach(this::topic);
            case "forumPosts" -> list.forEach(this::post);
            case "documents" -> list.forEach(this::document);
            case "culturalDonations" -> list.forEach(this::donation);
            case "culturalExpenses" -> list.forEach(this::expense);
            case "ledger" -> list.forEach(this::cash);
            case "bankTxns" -> bank(list);
            case "meetings" -> list.forEach(this::meeting);
            case "serviceContacts" -> list.forEach(this::contact);
            case "contactReviews" -> list.forEach(this::review);
            case "attendance" -> list.forEach(this::attendance);
            case "infraLog" -> list.forEach(this::condition);
            default -> d.skipped.put(c, "not on the v2 back end");
        }
    }
    /** After everything: who is on duty now. */
    void finish() {
        for (JsonNode h : d.collections.path("handymen")) {
            if (!h.path("clockedIn").asBoolean(false)) continue;
            UUID id = d.ids.get("handymen:" + h.path("id").asText());
            if (id == null) continue;
            d.attempt("handymen (on duty)", h, () -> {
                var f = d.as(d.admin, () -> d.s.staff().list(d.admin)).stream().filter((x) -> x.id().equals(id)).findFirst().orElseThrow();
                return f.clockedIn() ? f.id() : d.as(d.admin, () -> d.s.staff().clock(d.admin, id, true, f.version())).id();
            });
        }
    }

    // ---- bills: raised by the treasurer in their month, paid on their day (online through the payment gateway, or at the office) ----------------
    private void due(JsonNode r) {
        d.attempt("dues", r, () -> {
            UUID unit = d.unitIds.get(r.path("unit").asText());
            if (unit == null) throw new IllegalArgumentException("unknown unit " + r.path("unit").asText());
            LocalDate month = month(r.path("billedMonth").asText()), due = date(r, "dueDate");
            Caller t = d.role("treasurer");
            String what = r.path("category").asText() + " " + r.path("billedMonth").asText()
                + (r.has("unitsConsumed") ? " (" + r.path("previousReading").asText() + " to " + r.path("currentReading").asText() + ", " + r.path("unitsConsumed").asText() + " units)" : "");
            Due bill = d.at(d.on(month == null ? d.today : month, 10), t, () -> d.s.dues().raise(t, new DueService.RaiseDue(new UnitId(unit), r.path("category").asText(), month, what,
                Money.of(dec(r, "amount").toPlainString()), due)));
            if ("Paid".equals(r.path("status").asText())) pay(bill, r.path("paymentMode").asText(), due == null ? d.today : due.minusDays(3));
            return bill.id().value();
        });
    }
    private void pay(Due bill, String mode, LocalDate on) {
        Money total = bill.amount().plus(bill.tax());
        boolean online = d.s.gateway().isPresent() && Set.of("UPI", "Card", "Net banking").contains(mode);
        if (online) {
            Caller payer = d.ofUnit(unitNo(bill.unit().value()));
            if (payer != d.admin) {
                d.at(d.on(on, 11), payer, () -> {
                    PaymentService.OrderView o = d.s.payments().createOrder(payer, new PaymentService.CreateOrder(List.of(bill.id())), "demo-" + bill.id().value());
                    Map<String, String> paid = d.s.gateway().get().simulatePay(o.order().providerOrderRef(), true);
                    return d.s.payments().confirm(payer, o.order().id(), paid.get("providerPaymentRef"), paid.get("signature"));
                });
                return;
            }
        }
        String method = "Cash".equals(mode) || "Cheque".equals(mode) ? mode : "Bank transfer";
        Caller t = d.role("treasurer");
        d.at(d.on(on, 11), t, () -> d.s.counter().settle(t, new CounterSettlement.Request(bill.unit(), total, method, on, List.of(bill.id()), "Demo " + mode)));
    }
    private String unitNo(UUID id) { return d.unitIds.entrySet().stream().filter((e) -> e.getValue().equals(id)).map(Map.Entry::getKey).findFirst().orElse(null); }
    static LocalDate month(String label) {
        try { return YearMonth.parse(label, DateTimeFormatter.ofPattern("MMM yyyy", Locale.ENGLISH)).atDay(1); } catch (RuntimeException e) { return null; }
    }

    // ---- maintenance: raised by the person who raised it, assigned, worked, put on hold, closed and rated ------------------------------------
    private void ticket(JsonNode r) {
        d.attempt("tickets", r, () -> {
            String unitNo = r.path("unit").asText("");
            UUID unit = d.unitIds.get(unitNo);
            boolean community = unit == null;
            Caller by = d.who(text(r, "createdBy"), text(r, "createdByRole"));
            if (!community && by == d.admin) by = d.ofUnit(unitNo);
            UUID taskType = taskType(r.path("taskType").asText());
            Instant when = d.on(date(r, "createdAt") == null ? d.today : date(r, "createdAt"), 9);
            Ticket t = null; Caller raiser = null; RuntimeException refused = null;
            for (Caller c : List.of(by, d.role("facility_manager"), d.admin)) {      // the sample's raiser; else whoever may raise that kind of task
                Caller x = c;
                try {
                    t = d.at(when, x, () -> d.s.tickets().raise(x, new TicketService.RaiseTicket(taskType, r.path("title").asText(), text(r, "description"),
                        community ? null : new UnitId(unit), community ? "Community" : "Unit", community ? (text(r, "location") == null ? (unitNo.isBlank() ? "Common area" : unitNo) : text(r, "location")) : null,
                        r.path("category").asText(), null, r.path("priority").asText(), text(r, "preferredTime"), null)));
                    raiser = x; break;
                } catch (com.communityos.api.shared.security.AccessDenied e) { refused = e; }
            }
            if (t == null) throw refused;
            Caller fm = d.role("facility_manager");
            Instant later = when.plus(Duration.ofHours(1));
            // what the committee sets: the SLA date, parts awaited, materials, a financial task
            if (date(r, "slaDueAt") != null || r.path("awaitingParts").asBoolean() || r.path("materialsCost").asDouble() > 0 || (r.path("financial").asBoolean() && !t.state().financial)) {
                Ticket cur = t;
                Ticket.Changes ch = new Ticket.Changes(null, null, null, null, null, null, null, date(r, "slaDueAt"), r.path("awaitingParts").asBoolean() ? true : null,
                    r.path("materialsCost").asDouble() > 0 ? Money.of(dec(r, "materialsCost").toPlainString()) : null, r.path("financial").asBoolean() && !t.state().financial ? true : null, null);
                t = d.at(later, d.admin, () -> d.s.tickets().edit(d.admin, cur.id(), cur.version(), ch));
            }
            String status = r.path("status").asText("Open");
            String assignee0 = text(r, "assignedTo"); String assignee = assignee0;
            if (assignee0 != null && !"Open".equals(status)) {
                var m = d.byName.get(assignee0);
                if (m == null && "Facility Manager".equals(assignee0) && d.byRole.containsKey("facility_manager")) m = d.byRole.get("facility_manager").get(0);
                if (m != null) {
                    Ticket cur = t; Instant at = later.plus(Duration.ofMinutes(10));
                    var mid = m.id();
                    try { t = d.at(at, fm, () -> d.s.tickets().assign(fm, cur.id(), cur.version(), mid)); }
                    catch (RuntimeException notTheirTrade) {     // e.g. the facility manager on an MEP job: the person on that trade takes it
                        var other = d.as(fm, () -> d.s.tickets().assignees(fm, cur.id())).stream().filter((x) -> x.trade() != null).findFirst().orElseThrow(() -> notTheirTrade);
                        t = d.at(at, fm, () -> d.s.tickets().assign(fm, cur.id(), cur.version(), other.id()));
                        assignee = other.name();
                    }
                }
            }
            Caller worker = assignee == null ? fm : d.who(assignee, "facility_manager");
            List<TicketStatus> path = switch (status) {
                case "In Progress" -> List.of(TicketStatus.IN_PROGRESS);
                case "On Hold" -> List.of(TicketStatus.IN_PROGRESS, TicketStatus.ON_HOLD);
                case "Completed" -> List.of(TicketStatus.IN_PROGRESS, TicketStatus.COMPLETED);
                case "Closed" -> List.of(TicketStatus.IN_PROGRESS, TicketStatus.COMPLETED, TicketStatus.CLOSED);
                case "Cancelled" -> List.of(TicketStatus.CANCELLED);
                default -> List.of();
            };
            Instant step = later.plus(Duration.ofHours(2));
            Caller closer = raiser;
            for (TicketStatus to : path) {
                Ticket cur = t; Instant at = step;
                Caller who = to == TicketStatus.CLOSED ? closer : worker;
                String reason = to == TicketStatus.ON_HOLD ? "Waiting for parts" : to == TicketStatus.CANCELLED ? "Not needed" : null;
                t = d.at(at, who, () -> d.s.tickets().changeStatus(who, cur.id(), cur.version(), to, reason));
                step = step.plus(Duration.ofHours(20));
            }
            int rating = r.path("residentRating").asInt(0);
            Caller rater = raiser;
            if (rating > 0) { Ticket cur = t; d.at(step, rater, () -> d.s.tickets().rate(rater, cur.id(), rating)); }
            return t.id();
        });
    }
    private UUID taskType(String name) {
        return d.as(d.admin, () -> d.s.jdbc().query("SELECT id FROM maintenance.task_type WHERE name = :n", Map.of("n", name), (rs, i) -> rs.getObject("id", UUID.class)))
            .stream().findFirst().orElseThrow(() -> new IllegalArgumentException("no task type " + name));
    }
    private void ticketComment(JsonNode r) {
        d.attempt("ticketComments", r, () -> {
            UUID ticket = d.ref(r, "ticketId");
            if (ticket == null) throw new IllegalArgumentException("its ticket was not loaded");
            Caller by = d.who(text(r, "author"), text(r, "authorRoleId"));
            return d.at(instant(r, "createdAt"), by, () -> d.s.tickets().comment(by, ticket, r.path("body").asText(), r.path("visibility").asText("Public"))).id();
        });
    }
    private final Map<UUID, UUID> selected = new LinkedHashMap<>();
    private void quotation(JsonNode r) {
        d.attempt("quotations", r, () -> {
            UUID ticket = d.ref(r, "ticketId");
            if (ticket == null) throw new IllegalArgumentException("its ticket was not loaded");
            Caller fm = d.role("facility_manager");
            LocalDate on = date(r, "quoteDate");
            BigDecimal amount = dec(r, "amount");
            Quotation q = d.at(d.on(on, 12), fm, () -> d.s.quotations().add(fm, ticket, new QuotationService.AddDocument(r.path("kind").asText("Quotation"), r.path("vendor").asText(), amount,
                text(r, "gstMode") == null ? "Included" : text(r, "gstMode"), dec(r, "gstRate"), on, text(r, "note"))));
            // an invoice is decided on its own: the committee, then the treasurer
            if ("Invoice".equals(r.path("kind").asText())) q = decisions(q, r, on, "ecApproval", "finalApproval");
            return q.id();
        });
        for (JsonNode t : d.collections.path("tickets")) {
            JsonNode sel = t.path("selectedQuotationId");
            if (sel.isObject() && sel.path("$ref").asText().equals("quotations:" + r.path("id").asText())) {
                UUID tid = d.ids.get("tickets:" + t.path("id").asText()), qid = d.ids.get("quotations:" + r.path("id").asText());
                if (tid != null && qid != null) selected.put(qid, tid);
            }
        }
    }
    /** The chosen quotation of each purchase, then the committee's and the treasurer's decisions on it, as the ticket records them. */
    private void selections() {
        for (Map.Entry<UUID, UUID> e : selected.entrySet()) {
            JsonNode t = null;
            for (JsonNode x : d.collections.path("tickets")) if (e.getValue().equals(d.ids.get("tickets:" + x.path("id").asText()))) t = x;
            JsonNode tk = t;
            d.attempt("quotations (chosen)", tk, () -> {
                Caller fm = d.role("facility_manager");
                Quotation q = d.as(fm, () -> d.s.quotations().get(fm, e.getKey()));
                Quotation chosen = d.at(d.on(date(tk, "ecApprovedAt") == null ? d.today : date(tk, "ecApprovedAt").minusDays(1), 10), fm, () -> d.s.quotations().select(fm, q.id(), q.version()));
                return decisions(chosen, tk, date(tk, "ecApprovedAt"), "ecApproval", "treasurerApproval").id();
            });
        }
    }
    private Quotation decisions(Quotation q, JsonNode r, LocalDate on, String ecField, String finalField) {
        Quotation cur = q;
        if ("Approved".equals(r.path(ecField).asText()) || "Rejected".equals(r.path(ecField).asText())) {
            Caller p = d.who(text(r, ecField + "edBy"), "president"); String v = r.path(ecField).asText(); Quotation x = cur;
            cur = d.at(d.on(on == null ? d.today : on, 18), p, () -> d.s.quotations().decide(p, x.id(), x.version(), v, null, false));
        }
        if ("Approved".equals(r.path(finalField).asText()) || "Rejected".equals(r.path(finalField).asText())) {
            Caller t = d.who(text(r, finalField + "edBy"), "treasurer"); String v = r.path(finalField).asText(); Quotation x = cur;
            LocalDate fin = date(r, finalField + "edAt");
            cur = d.at(d.on(fin == null ? (on == null ? d.today : on) : fin, 19), t, () -> d.s.quotations().decide(t, x.id(), x.version(), v, null, true));
        }
        return cur;
    }

    // ---- amenity bookings: made the week before (or today, for one still ahead), paid, used, cancelled ------------------------------------
    private void booking(JsonNode r) {
        d.attempt("amenities", r, () -> {
            UUID type = typeByName(r.path("amenity").asText());
            UUID unit = d.unitIds.get(r.path("unit").asText());
            LocalDate on = date(r, "date");
            Caller desk = d.role("facility_manager");
            String slot = "Full day".equals(r.path("slot").asText()) ? null : r.path("slot").asText();
            Instant made = d.on(on.minusDays(7), 10);
            boolean paid = "Paid".equals(r.path("paymentStatus").asText());
            String mode = text(r, "paymentMode");
            // paid: booked at the desk, which takes the money then; not paid: booked by the household, to pay at the office later
            Caller by = paid ? desk : d.ofUnit(r.path("unit").asText());
            String how = paid ? mode : mode == null ? null : Set.of("UPI", "Card", "Net banking").contains(mode) ? "Cash" : mode;
            Booking b = d.at(made, by, () -> d.s.bookings().book(by, new BookingService.Book(type, unit == null ? null : new UnitId(unit), on, slot, how, null, false, "Unit", null, false, null, Map.of())));
            String status = r.path("status").asText();
            if (paid) {
                Booking cur = b;
                if (!"Paid".equals(cur.state().paymentStatus) && !"Not required".equals(cur.state().paymentStatus))
                    b = d.at(made.plus(Duration.ofHours(2)), desk, () -> d.s.bookings().receivePayment(desk, cur.id(), cur.version(), mode == null ? "Cash" : mode, "Demo"));
            }
            if ("Completed".equals(status)) { Booking cur = b; b = d.at(d.on(on, 23), desk, () -> d.s.bookings().complete(desk, cur.id(), cur.version())); }
            if ("Cancelled".equals(status)) {
                Booking cur = b; Instant when = instant(r, "cancelledAt") != null ? instant(r, "cancelledAt") : made.plus(Duration.ofDays(1));
                b = d.at(when, desk, () -> d.s.bookings().cancel(desk, cur.id(), cur.version(), new BookingService.Cancel(text(r, "cancelReason") == null ? "Plans changed" : text(r, "cancelReason"), null, false, null)));
            }
            return b.id();
        });
    }
    private UUID typeByName(String name) {
        for (JsonNode t : d.collections.path("amenityTypes")) if (name.equals(t.path("name").asText())) {
            UUID id = d.ids.get("amenityTypes:" + t.path("id").asText());
            if (id != null) return id;
        }
        throw new IllegalArgumentException("no amenity " + name);
    }

    // ---- the gate: passes made by the household, visits as the guard saw them -------------------------------------------------------------
    private void pass(JsonNode r) {
        d.attempt("gatePasses", r, () -> {
            String unitNo = r.path("unit").asText();
            UUID unit = d.unitIds.get(unitNo);
            Caller host = text(r, "hostName") != null && d.byName.containsKey(text(r, "hostName")) ? d.who(text(r, "hostName"), null) : d.ofUnit(unitNo);
            LocalDate from = date(r, "validFrom");
            List<String> days = new ArrayList<>(); r.path("days").forEach((x) -> days.add(x.asText()));
            Integer cap = r.path("guestCap").isNumber() ? r.path("guestCap").asInt() : null;
            Gate.Pass p = d.at(d.on(from == null ? d.today : from, 8), host, () -> d.s.gate().createPass(host, new GateService.NewPass(r.path("visitorName").asText(), phone(text(r, "phone")),
                unit == null ? null : new UnitId(unit), r.path("type").asText("One-time"), from, date(r, "validTo"), time(r, "fromTime"), time(r, "toTime"), days, text(r, "vehicle"), cap,
                text(r, "goodsKind"), r.path("peopleCount").isNumber() ? r.path("peopleCount").asInt() : null, text(r, "material"), r.path("carryingOut").asBoolean(false), text(r, "outItems"), null)));
            return p.id;
        });
    }
    private void visit(JsonNode r) {
        String kind = r.path("kind").asText();
        if ("Resident vehicle".equals(kind)) { d.skipped.merge("gateVisits", "a resident's own car (read by FASTag) is not a visit on v2", (a, b) -> a); return; }
        d.attempt("gateVisits", r, () -> {
            Caller guard = d.role("handyman_security");
            String gate = r.path("gate").asText("Main gate");
            UUID unit = d.unitIds.get(r.path("unit").asText());
            Instant in = instant(r, "inAt"), out = instant(r, "outAt");
            UUID pass = d.ref(r, "passId"), person = d.ref(r, "personId");
            Gate.Visit v;
            GateService.Outcome o;
            if (pass != null) o = d.at(in, guard, () -> d.s.gate().admitPass(guard, pass, gate, text(r, "vehicle"), null));
            else if (person != null) o = d.at(in, guard, () -> d.s.gate().admitPerson(guard, person, gate, r.path("method").asText("Face"), unit == null ? null : new UnitId(unit)));
            else if ("Delivery".equals(kind)) o = d.at(in, guard, () -> d.s.gate().delivery(guard, r.path("name").asText(), phone(text(r, "phone")), null, text(r, "company"),
                unit == null ? null : new UnitId(unit), gate, text(r, "vehicle")));
            else o = d.at(in, guard, () -> d.s.gate().ask(guard, new GateService.Ask(kind, r.path("name").asText(), phone(text(r, "phone")), text(r, "company"), text(r, "vehicle"),
                r.path("purpose").asText(), unit == null ? null : new UnitId(unit), gate, null, null, d.ref(r, "workOrderId"), null, null)));
            if (!o.ok() && o.visit() == null && o.approval() == null) throw new IllegalArgumentException(o.reason() == null ? o.outcome() : o.reason());
            v = o.visit();
            if (o.approval() != null) {
                for (JsonNode a : d.collections.path("gateApprovals")) if (a.path("visitId").path("$ref").asText().equals("gateVisits:" + r.path("id").asText())) d.ids.put("gateApprovals:" + a.path("id").asText(), o.approval().id);
                String state = r.path("state").asText();
                if (!"Awaiting approval".equals(state)) {          // the unit answered: no for a denied caller, yes for one who came in
                    Caller host = d.ofUnit(r.path("unit").asText());
                    String decision = "Denied".equals(state) ? "Denied" : "Approved";
                    UUID approval = o.approval().id;
                    d.at(in.plus(Duration.ofMinutes(1)), host, () -> d.s.gate().answer(host, approval, decision, false));
                    v = visitNow(guard, o.visit().id);
                    if (!"Denied".equals(state)) { Gate.Visit w = v; v = d.at(in.plus(Duration.ofMinutes(2)), guard, () -> d.s.gate().admitApproved(guard, w.id, w.version, null)); }
                }
            }
            if (v != null && out != null && "Exited".equals(r.path("state").asText())) {
                Gate.Visit cur = v;
                v = person != null && cur.state == Gate.VisitState.INSIDE ? d.at(out, guard, () -> d.s.gate().exitPerson(guard, person, r.path("method").asText("Face")))
                    : d.at(out, guard, () -> d.s.gate().exit(guard, cur.id, cur.version, "Guard manual"));
            }
            return v == null ? null : v.id;
        });
    }
    private Gate.Visit visitNow(Caller guard, UUID id) {
        return d.as(guard, () -> d.s.gate().visits(guard, new com.communityos.api.gate.application.port.GateStore.VisitFilter(null, null, null, null, false))).stream()
            .filter((x) -> x.id.equals(id)).findFirst().orElseThrow();
    }

    // ---- comms ---------------------------------------------------------------------------------------------------------------------------------
    private void broadcast(JsonNode r) {
        d.attempt("broadcasts", r, () -> {
            Caller sec = d.role("general_secretary");
            List<String> options = new ArrayList<>(); r.path("pollOptions").forEach((x) -> options.add(x.isTextual() ? x.asText() : x.path("label").asText()));
            return d.at(d.on(date(r, "sentAt") == null ? d.today : date(r, "sentAt"), 9), sec, () -> d.s.notices().create(sec, new BroadcastService.Draft(r.path("type").asText("Notice"),
                r.path("audience").asText("All residents"), r.path("subject").asText(), r.path("message").asText(), List.of(), List.of(), date(r, "eventDate"), text(r, "startTime"),
                text(r, "endTime"), text(r, "affects"), options.isEmpty() ? null : options, null, date(r, "pollClosesOn"), r.path("requiresSignature").asBoolean(false),
                text(r, "reminderFrequency")), !"Draft".equals(r.path("status").asText()), null)).id;
        });
    }
    private void topic(JsonNode r) {
        d.attempt("forum", r, () -> {
            Caller by = d.who(text(r, "author"), "general_secretary");
            List<String> options = new ArrayList<>(); r.path("pollOptions").forEach((x) -> options.add(x.isTextual() ? x.asText() : x.path("label").asText()));
            Instant when = firstPost(r.path("id").asText());
            Comms.Topic t = d.at(when == null ? null : when.minus(Duration.ofHours(1)), by, () -> d.s.forum().start(by, new ForumService.NewTopic(r.path("title").asText(),
                r.path("category").asText("General"), r.path("kind").asText("Discussion"), options)));
            if (r.path("pinned").asBoolean(false) || "Closed".equals(r.path("status").asText())) {
                Caller sec = d.role("general_secretary"); Comms.Topic cur = t;
                t = d.as(sec, () -> d.s.forum().change(sec, cur.id, cur.version, new ForumService.TopicChange(null, null, r.path("pinned").asBoolean(false) ? true : null,
                    "Closed".equals(r.path("status").asText()) ? "Closed" : null)));
            }
            return t.id;
        });
    }
    private Instant firstPost(String topicId) {
        for (JsonNode p : d.collections.path("forumPosts")) if (p.path("topicId").path("$ref").asText().equals("forum:" + topicId)) return instant(p, "createdAt");
        return null;
    }
    private void post(JsonNode r) {
        d.attempt("forumPosts", r, () -> {
            UUID topic = d.ref(r, "topicId");
            if (topic == null) throw new IllegalArgumentException("its topic was not loaded");
            Caller by = d.who(text(r, "author"), text(r, "authorRoleId"));
            UUID parent = d.ref(r, "parentId");
            return d.at(instant(r, "createdAt"), by, () -> d.s.forum().reply(by, topic, parent, r.path("body").asText())).id;
        });
    }

    // ---- documents: a short PDF for each, filed with its access ---------------------------------------------------------------------------------
    private void document(JsonNode r) {
        d.attempt("documents", r, () -> {
            Caller sec = d.role("general_secretary");
            String title = r.path("title").asText();
            UUID unit = d.unitIds.get(r.path("unit").asText(""));
            var f = d.as(sec, () -> d.s.files().upload(sec, new FileService.Upload(title.replaceAll("[^A-Za-z0-9 .-]", "").strip().replace(' ', '-') + ".pdf", pdf(title), null)));
            return d.as(sec, () -> d.s.documents().file(sec, f.id(), new DocumentService.Fields(title, text(r, "category"), text(r, "version"), r.path("access").asText("Everyone"), unit,
                date(r, "expiry"), null))).id;
        });
    }
    /** A small valid PDF with one line of text. */
    static byte[] pdf(String text) {
        String t = text.replaceAll("[^\\x20-\\x7E]", "-").replace("(", "").replace(")", "").replace("\\", "");
        String stream = "BT /F1 18 Tf 72 720 Td (" + t + ") Tj ET";
        String[] objs = {"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            "<< /Length " + stream.length() + " >>\nstream\n" + stream + "\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"};
        StringBuilder b = new StringBuilder("%PDF-1.4\n"); List<Integer> at = new ArrayList<>();
        for (int i = 0; i < objs.length; i++) { at.add(b.length()); b.append(i + 1).append(" 0 obj\n").append(objs[i]).append("\nendobj\n"); }
        int xref = b.length();
        b.append("xref\n0 ").append(objs.length + 1).append("\n0000000000 65535 f \n");
        for (int o : at) b.append(String.format("%010d 00000 n \n", o));
        b.append("trailer\n<< /Size ").append(objs.length + 1).append(" /Root 1 0 R >>\nstartxref\n").append(xref).append("\n%%EOF\n");
        return b.toString().getBytes(StandardCharsets.ISO_8859_1);
    }

    // ---- cultural: donations recorded by the committee, expenses raised, approved and paid ---------------------------------------------------
    /** The cultural committee records the money of its events (the Super Admin when the sample data has no committee member). */
    private Caller committee() { return d.byRole.containsKey("committee_cultural") ? d.role("committee_cultural") : d.admin; }
    private void donation(JsonNode r) {
        d.attempt("culturalDonations", r, () -> {
            UUID event = d.ref(r, "eventId");
            if (event == null) throw new IllegalArgumentException("its event was not loaded");
            Caller c = committee();
            UUID unit = d.unitIds.get(r.path("unit").asText(""));
            boolean received = "Received".equals(r.path("status").asText());
            LocalDate on = date(r, "date");
            Cultural.Donation x = d.at(d.on(on == null ? d.today : on, 12), c, () -> d.s.donations().record(c, new DonationService.Pledge(event, r.path("donor").asText(), unit,
                r.path("kind").asText("Donation"), r.path("towards").asText("General"), dec(r, "amount"), on, received ? r.path("mode").asText("UPI") : text(r, "mode"), text(r, "reference"),
                r.path("anonymous").asBoolean(false), text(r, "note"), phone(text(r, "phone")), text(r, "members"), text(r, "sankalpam"), d.ref(r, "offeringId")), received));
            return x.id;
        });
    }
    private void expense(JsonNode r) {
        d.attempt("culturalExpenses", r, () -> {
            UUID event = d.ref(r, "eventId");
            if (event == null) throw new IllegalArgumentException("its event was not loaded");
            Caller c = committee();
            LocalDate on = date(r, "date");
            Instant at = d.on(on == null ? d.today : on, 10);
            Cultural.Expense x = d.at(at, c, () -> d.s.expenses().raise(c, event, new ExpenseService.Fields(r.path("item").asText(), r.path("category").asText(), text(r, "vendor"),
                dec(r, "amount"), null, on, text(r, "fund"), text(r, "note"))));
            if ("Approved".equals(r.path("ecApproval").asText())) {
                Caller p = d.role("president"); Cultural.Expense cur = x;
                x = d.at(at.plus(Duration.ofHours(2)), p, () -> d.s.expenses().decide(p, cur.id, cur.version, "Approved", null, false));
            }
            if ("Approved".equals(r.path("ecApproval").asText()) && r.path("finalRequired").asBoolean(false) && !"Approved".equals(x.status)) {
                Caller t = d.role("treasurer"); Cultural.Expense cur = x;
                if (cur.status != null && cur.status.contains("approval")) x = d.at(at.plus(Duration.ofHours(4)), t, () -> d.s.expenses().decide(t, cur.id, cur.version, "Approved", null, true));
            }
            if ("Paid".equals(r.path("status").asText())) {
                Caller t = d.role("treasurer"); Cultural.Expense cur = x;
                String paidBy = r.path("paidBy").asText("UPI");
                String mode = paidBy.contains("·") ? paidBy.substring(paidBy.indexOf('·') + 1).strip() : paidBy;
                x = d.at(at.plus(Duration.ofHours(6)), t, () -> d.s.expenses().pay(t, cur.id, cur.version, mode));
            }
            return x.id;
        });
    }

    // ---- the cash book and the bank statements -------------------------------------------------------------------------------------------------
    private void cash(JsonNode r) {
        if ("due".equals(r.path("sourceType").asText())) { d.skipped.merge("ledger", "an entry a bill's payment made is made again by that payment", (a, b) -> a); return; }
        d.attempt("ledger", r, () -> {
            Caller t = d.role("treasurer");
            Books.Entry e = new Books.Entry();
            e.date = date(r, "date"); e.type = r.path("type").asText(); e.account = r.path("account").asText();
            e.category = text(r, "category"); e.vendor = text(r, "vendor"); e.invoiceNo = text(r, "invoiceNo"); e.mode = text(r, "mode") == null ? "Bank transfer" : text(r, "mode"); e.fund = text(r, "fund");
            e.description = text(r, "description") != null ? text(r, "description") : "Credit".equals(e.type) ? "Maintenance collections" : (e.category == null ? "Payment" : e.category) + (e.vendor == null ? "" : " - " + e.vendor);
            String acct = e.account == null ? "" : e.account;
            e.module = text(r, "module") != null ? text(r, "module") : "Amenity".equals(e.category) ? "Amenities" : acct.contains("Electricity") ? "Utilities" : "Sinking".equals(acct) ? "Capex / projects"
                : "Corpus".equals(acct) ? "Other" : "Credit".equals(e.type) ? "Dues" : "Maintenance";
            UUID unit = d.unitIds.get(r.path("unit").asText(""));
            if (unit != null) e.unitId = unit;
            BigDecimal base = dec(r, "baseAmount");
            if (base != null && base.signum() > 0) { e.baseAmount = base; e.gstRate = dec(r, "gstRate"); }
            else e.amount = dec(r, "amount");
            return d.at(d.on(e.date, 15), t, () -> d.s.cash().record(t, e)).id;
        });
    }
    private void bank(JsonNode list) {
        Map<String, List<Books.BankLine>> byAccount = new LinkedHashMap<>();
        for (JsonNode r : list) byAccount.computeIfAbsent(r.path("account").asText("Maintenance"), (k) -> new ArrayList<>()).add(new Books.BankLine(null, null, date(r, "date"), r.path("account").asText(),
            r.path("narration").asText(), text(r, "head"), dec(r, "debit"), dec(r, "credit"), dec(r, "balance"), text(r, "party"), text(r, "remarks"), null, 0));
        Caller t = d.role("treasurer");
        for (Map.Entry<String, List<Books.BankLine>> e : byAccount.entrySet()) {
            try {
                var res = d.as(t, () -> d.s.bank().importLines(t, e.getKey(), e.getValue()));
                d.rows.merge("bankTxns", res.added(), Integer::sum);
                if (res.skipped() > 0) d.skipped.merge("bankTxns", res.skipped() + " lines repeated on the " + e.getKey() + " statement are kept once", (a, b) -> a + "; " + b);
            } catch (RuntimeException x) { d.problems.add("bankTxns " + e.getKey() + ": " + x.getMessage()); }
        }
    }

    // ---- governance --------------------------------------------------------------------------------------------------------------------------------
    private void meeting(JsonNode r) {
        d.attempt("meetings", r, () -> {
            Caller sec = d.role("general_secretary");
            LocalDate on = date(r, "date");
            String status = r.path("status").asText("Scheduled");
            String committee = r.path("committee").asText("Executive Committee");
            String visibility = text(r, "visibility") != null ? text(r, "visibility") : committee.contains("General") ? "Published to residents" : "Internal (committee only)";
            boolean done = "Completed".equals(status);
            Governance.Meeting m = d.at(d.on(on.minusDays(7), 10), sec, () -> d.s.meetings().create(sec, new MeetingService.Fields(r.path("title").asText(), committee, on, time(r, "startTime"),
                time(r, "endTime"), text(r, "location"), done ? "Scheduled" : status, visibility, text(r, "agenda"), null, text(r, "cancelReason"))));
            if (done) {
                Governance.Meeting cur = m;
                m = d.at(d.on(on.plusDays(1), 10), sec, () -> d.s.meetings().update(sec, cur.id, cur.version, new MeetingService.Fields(r.path("title").asText(), committee, on, time(r, "startTime"),
                    time(r, "endTime"), text(r, "location"), "Completed", visibility, text(r, "agenda"), text(r, "minutes"), null)));
            }
            return m.id;
        });
    }

    // ---- the directory: contacts added by residents, their reviews ---------------------------------------------------------------------------
    private void contact(JsonNode r) {
        d.attempt("serviceContacts", r, () -> {
            Caller by = d.who(text(r, "addedBy"), null);
            if (by == d.admin && text(r, "addedByUnit") != null) by = d.ofUnit(text(r, "addedByUnit"));
            Caller who = by;
            Directory.Contact c = d.as(who, () -> d.s.directory().add(who, new DirectoryService.ContactFields(r.path("name").asText(), text(r, "category"), text(r, "phone"), text(r, "area"),
                text(r, "rate"), text(r, "notes"), null, null, null)));
            if ("Hidden".equals(r.path("status").asText())) {
                Caller fm = d.role("facility_manager"); Directory.Contact cur = c;
                c = d.as(fm, () -> d.s.directory().change(fm, cur.id, cur.version, new DirectoryService.ContactFields(cur.name, cur.category, cur.phone, cur.area, cur.rate, cur.notes, null, "Hidden",
                    text(r, "hiddenReason") == null ? "Hidden by the committee" : text(r, "hiddenReason"))));
            }
            return c.id;
        });
    }
    private void review(JsonNode r) {
        d.attempt("contactReviews", r, () -> {
            UUID contact = d.ref(r, "contactId");
            if (contact == null) throw new IllegalArgumentException("its contact was not loaded");
            Caller by = d.who(text(r, "author"), null);
            if (by == d.admin && text(r, "unit") != null) by = d.ofUnit(text(r, "unit"));
            Caller who = by;
            return d.at(instant(r, "createdAt"), who, () -> d.s.directory().review(who, contact, new DirectoryService.ReviewFields(r.path("rating").asInt(), text(r, "comment"), text(r, "recommend")))).id;
        });
    }

    // ---- an asset's condition log: written by the asset service (it also sets the asset's condition) ---------------------------------------
    private void condition(JsonNode r) {
        d.attempt("infraLog", r, () -> {
            UUID asset = d.ref(r, "assetId");
            if (asset == null) throw new IllegalArgumentException("its asset was not loaded");
            Caller fm = d.role("facility_manager");
            LocalDate on = date(r, "date");
            return d.at(d.on(on == null ? d.today : on, 17), fm, () -> d.s.assets().condition(fm, asset, on, r.path("condition").asText(), r.path("source").asText("Inspection"),
                text(r, "note"), d.ref(r, "ticketId"))).id();
        });
    }

    // ---- attendance: each member clocks in and out on their own day, where they were -------------------------------------------------------
    private void attendance(JsonNode r) {
        d.attempt("attendance", r, () -> {
            var m = d.byName.get(r.path("staffName").asText());
            if (m == null) throw new IllegalArgumentException(r.path("staffName").asText() + " is not a member");
            Caller who = d.caller(m);
            Instant in = instant(r, "clockIn"), out = instant(r, "clockOut");
            Attendance.Session sess = d.at(in, who, () -> d.s.attendance().clockIn(who, position(r, "in"), text(r, "shiftType"), text(r, "note")));
            if (out != null) sess = d.at(out, who, () -> d.s.attendance().clockOut(who, position(r, "out"), null));
            return sess.id;
        });
    }
    private static AttendanceService.Position position(JsonNode r, String p) {
        BigDecimal lat = dec(r, p + "Lat"), lng = dec(r, p + "Lng");
        return lat == null || lng == null ? null : new AttendanceService.Position(lat, lng, dec(r, p + "Acc"));
    }
}
