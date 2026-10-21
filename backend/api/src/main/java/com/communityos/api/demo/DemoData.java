package com.communityos.api.demo;

import com.communityos.api.amenity.AmenityResources;
import com.communityos.api.amenity.application.BookingService;
import com.communityos.api.assets.AssetResources;
import com.communityos.api.assets.application.AssetService;
import com.communityos.api.billing.application.CounterSettlement;
import com.communityos.api.billing.application.DueService;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.comms.application.BroadcastService;
import com.communityos.api.comms.application.ForumService;
import com.communityos.api.cultural.CulturalResources;
import com.communityos.api.cultural.application.DonationService;
import com.communityos.api.cultural.application.ExpenseService;
import com.communityos.api.docs.DocsResources;
import com.communityos.api.docs.application.DocumentService;
import com.communityos.api.docs.application.FileService;
import com.communityos.api.finance.application.CashBookService;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.gate.application.GateService;
import com.communityos.api.governance.application.BallotService;
import com.communityos.api.governance.application.MeetingService;
import com.communityos.api.identity.application.MemberService;
import com.communityos.api.shared.security.CallerLoader;
import com.communityos.api.identity.domain.MemberView;
import com.communityos.api.maintenance.application.FieldStaffService;
import com.communityos.api.maintenance.application.QuotationService;
import com.communityos.api.maintenance.application.TicketService;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.maintenance.domain.TicketStatus;
import com.communityos.api.reports.ReportResources;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.JdbcResourceRepository;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceService;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.vendor.VendorResources;
import com.communityos.api.vendor.application.DirectoryService;
import com.communityos.api.workforce.WorkforceResources;
import com.communityos.api.workforce.application.AttendanceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * The La Paloma demo: a community with its committee, staff, owners and tenants, and a few weeks of life in every module - bills and receipts,
 * tasks, bookings, the gate, notices and the forum, documents, Diwali with pledges and an expense, the cash book, an AGM and an open ballot,
 * vendors and the directory, assets and stock, attendance and shifts, report schedules.
 *
 * Everything goes through the real services as the people who would do it (the treasurer raises bills, an owner pledges, the plumber
 * clocks in), so the books balance, the audit trail and the inboxes are what they would be. It runs once per community (the demo members'
 * phones are the marker); dev and test only (DemoConfig).
 */
public final class DemoData {
    /** The services the demo uses - the same ones the API uses. */
    public record Services(NamedParameterJdbcTemplate jdbc, ObjectMapper json, CallerLoader callers, MemberService members, FieldStaffService staff, DueService dues,
                           CounterSettlement counter, TicketService tickets, QuotationService quotations, ResourceService kit, BookingService bookings, GateService gate,
                           BroadcastService notices, ForumService forum, FileService files, DocumentService documents, DonationService donations, ExpenseService expenses,
                           CashBookService cash, MeetingService meetings, BallotService ballots, DirectoryService directory, AssetService assets, AttendanceService attendance,
                           Clock clock, ZoneId zone) {}
    public record Result(boolean loaded, String message, int members, int bills) {}

    /** Demo phones: +91 98000 0xxxx (the seeded Super Admin is +91 98000 00000). */
    public static final String MARKER_PHONE = "+919800001001";
    static String phone(int n) { return "+9198000" + String.format("%05d", n); }

    static final String[] OWNERS = {"Arjun Reddy", "Priya Sharma", "Vikram Nair", "Kavita Joshi", "Rahul Verma", "Sneha Kulkarni", "Anil Kapoor", "Deepa Menon", "Sanjay Gupta",
        "Meera Krishnan", "Karthik Subramanian", "Neha Agarwal", "Rohan Das", "Pooja Hegde", "Manoj Pillai", "Shalini Rao", "Aditya Bose", "Nandini Iyer", "Farhan Qureshi",
        "Geeta Bhat", "Harish Chandra", "Isha Malhotra", "Jayant Kulkarni", "Lata Mangesh", "Mohan Das", "Nisha Patel", "Omkar Joshi", "Padma Lakshmi"};
    static final String[] TENANTS = {"Tom Mathew", "Sara Thomas", "Imran Khan", "Ritu Singh"};

    private final Services s;
    private final Map<String, Caller> who = new LinkedHashMap<>();
    private final Map<Integer, UUID> unitIds = new LinkedHashMap<>();
    private final List<Caller> owners = new ArrayList<>();
    private CommunityId community;
    private LocalDate today;

    public DemoData(Services s) { this.s = s; }

    /** Load the demo into the community, signed in as its Super Admin (the seeded one). Safe to call again: the second time it says so and does nothing. */
    public Result load(CommunityId community, Caller superAdmin) {
        this.community = community; this.today = LocalDate.now(s.clock().withZone(s.zone()));
        Boolean done = as(superAdmin, () -> !s.jdbc().query("SELECT 1 AS x FROM identity.membership m JOIN identity.person p ON p.id = m.person_id WHERE p.phone_e164 = :p",
            Map.of("p", MARKER_PHONE), (rs, i) -> 1).isEmpty());
        if (Boolean.TRUE.equals(done)) return new Result(false, "The demo is already loaded in this community", 0, 0);
        for (Map.Entry<String, Object> u : as(superAdmin, () -> s.jdbc().query("SELECT id, unit_no FROM property.unit", Map.of(), (rs, i) -> Map.<String, Object>entry(rs.getString("unit_no"), rs.getObject("id", UUID.class)))))
            if (u.getKey().startsWith("Villa ")) try { unitIds.put(Integer.parseInt(u.getKey().substring(6).strip()), (UUID) u.getValue()); } catch (NumberFormatException ignored) { }
        for (int v : new int[] {1, 34, 112, 127, 145, 188}) if (!unitIds.containsKey(v)) throw new IllegalStateException("The demo needs Villa 1 .. Villa 188 at least (seed the villas first)");
        who.put("admin", superAdmin);

        people(superAdmin);
        int bills = billing();
        workforce();
        maintenance();
        amenities();
        gate();
        comms();
        documents();
        cultural();
        finance();
        governance();
        vendors();
        assets();
        reports();
        return new Result(true, "La Paloma demo loaded", who.size() - 1 + owners.size(), bills);
    }

    // ---- people ------------------------------------------------------------------------------------------------------------------------------------
    void people(Caller admin) {
        member(admin, "president", 1001, "Ramesh Iyer", "president", 112, "Owner");
        member(admin, "secretary", 1002, "Anita Rao", "general_secretary", 127, "Owner");
        member(admin, "treasurer", 1003, "Suresh Menon", "treasurer", 145, "Owner");
        member(admin, "cultural", 1004, "Lakshmi Narayan", "committee_cultural", 188, "Owner");
        member(admin, "fm", 1101, "Prakash Kumar", "facility_manager", null, null);
        member(admin, "helpdesk", 1102, "Divya S", "helpdesk", null, null);
        member(admin, "plumber", 1103, "Ravi Plumber", "handyman_plumbing", null, null);
        member(admin, "electrician", 1104, "Salim Electrician", "handyman_electrical", null, null);
        member(admin, "mep", 1105, "Joseph MEP", "handyman_mep", null, null);
        member(admin, "guard", 1106, "Bahadur Security", "handyman_security", null, null);
        for (int i = 0; i < OWNERS.length; i++) owners.add(caller(add(admin, phone(1201 + i), OWNERS[i], "owner", i + 1, "Owner")));
        for (int i = 0; i < TENANTS.length; i++) who.put("tenant" + i, caller(add(admin, phone(1301 + i), TENANTS[i], "resident", 31 + i, "Tenant")));
        Caller fm = who.get("fm");
        for (String[] f : new String[][] {{"plumber", "Plumbing", "Morning"}, {"electrician", "Electrical", "Morning"}, {"mep", "MEP", "Afternoon"}, {"guard", "Security", "Night"}}) {
            Caller x = who.get(f[0]);
            as(admin, () -> s.staff().add(admin, x.membership(), f[1], f[2], null));
        }
        if (fm == null) throw new IllegalStateException("no facility manager");
    }
    void member(Caller admin, String key, int n, String name, String role, Integer villa, String relation) { who.put(key, caller(add(admin, phone(n), name, role, villa, relation))); }
    MemberView add(Caller admin, String phone, String name, String role, Integer villa, String relation) {
        return as(admin, () -> s.members().add(admin, new MemberService.AddMember(phone, name, null, role, villa == null ? null : new UnitId(unitIds.get(villa)), relation)));
    }
    Caller caller(MemberView m) { return s.callers().load(m.person(), community, m.id()).orElseThrow(() -> new IllegalStateException("cannot sign in as " + m.displayName())); }
    Caller owner(int villa) { return owners.get(villa - 1); }

    // ---- billing: September (mostly paid) and October maintenance, water ---------------------------------------------------------------------------
    int billing() {
        Caller t = who.get("treasurer");
        LocalDate sep = today.withDayOfMonth(1).minusMonths(1), oct = today.withDayOfMonth(1);
        int n = 0;
        for (int v = 1; v <= 34; v++) {
            UnitId unit = new UnitId(unitIds.get(v));
            Due d1 = as(t, () -> s.dues().raise(t, new DueService.RaiseDue(unit, "Maintenance", sep, "Maintenance " + sep.getMonth(), Money.of("3000"), sep.plusDays(14))));
            as(t, () -> s.dues().raise(t, new DueService.RaiseDue(unit, "Maintenance", oct, "Maintenance " + oct.getMonth(), Money.of("3000"), oct.plusDays(14))));
            int vv = v;
            as(t, () -> s.dues().raise(t, new DueService.RaiseDue(unit, "Water", oct, "Water " + oct.getMonth(), Money.of(String.valueOf(300 + (vv * 37) % 400)), oct.plusDays(14))));
            n += 3;
            if (v % 5 != 0) {   // four in five paid September at the office
                as(t, () -> s.counter().settle(t, new CounterSettlement.Request(unit, d1.amount().plus(d1.tax()), vv % 3 == 0 ? "Cheque" : "Bank transfer", sep.plusDays(5 + vv % 9),
                    List.of(d1.id()), "DEMO-" + vv)));
            }
        }
        return n;
    }

    // ---- workforce: the site, this week's shifts, the plumber and electrician clocked in ----------------------------------------------------------
    void workforce() {
        Caller admin = who.get("admin");
        var setRepo = repo(WorkforceResources.SETTINGS);
        var site = as(admin, () -> s.kit().list(admin, WorkforceResources.SETTINGS, setRepo)).get(0);
        as(admin, () -> s.kit().replace(admin, WorkforceResources.SETTINGS, setRepo, site.id(), site.version(), new WorkforceResources.SettingFields("La Paloma main gate",
            new BigDecimal("17.4401"), new BigDecimal("78.3489"), 400, "Record only (flag exceptions)", 15, Map.of("Morning", "06:00", "Afternoon", "14:00", "General", "09:00"), new BigDecimal("12"))));
        var shifts = repo(WorkforceResources.SHIFTS);
        List<UUID> staffIds = as(admin, () -> s.jdbc().query("SELECT id FROM maintenance.field_staff ORDER BY name", Map.of(), (rs, i) -> rs.getObject("id", UUID.class)));
        String[] pattern = {"Morning", "Morning", "Afternoon", "General", "Off", "Morning", "General"};
        for (int d = 0; d < 7; d++) for (int k = 0; k < staffIds.size(); k++) {
            int dd = d, kk = k;
            as(admin, () -> s.kit().create(admin, WorkforceResources.SHIFTS, shifts, new WorkforceResources.ShiftFields(staffIds.get(kk), today.plusDays(dd), pattern[(dd + kk) % pattern.length], null)));
        }
        var holidays = repo(WorkforceResources.HOLIDAYS);
        LocalDate diwali = diwali();
        as(admin, () -> s.kit().create(admin, WorkforceResources.HOLIDAYS, holidays, new WorkforceResources.HolidayFields(diwali, "Diwali", "No pickup", null, "Not allowed", null, null,
            "Gate open for residents' guests only", null)));
        var services = repo(WorkforceResources.SERVICES);
        as(admin, () -> s.kit().create(admin, WorkforceResources.SERVICES, services, new WorkforceResources.ServiceFields("Garbage pickup", "🗑️", "Collection", "07:00", "09:00",
            List.of("Mon", "Tue", "Wed", "Thu", "Fri", "Sat"), "All lanes", "Keep dry and wet waste separate", true, 1)));
        as(admin, () -> s.kit().create(admin, WorkforceResources.SERVICES, services, new WorkforceResources.ServiceFields("Workers allowed", "🧰", "Access", "09:00", "18:00",
            List.of("Mon", "Tue", "Wed", "Thu", "Fri", "Sat"), null, "No work on Sundays", true, 2)));
        for (String k : List.of("plumber", "electrician")) { Caller x = who.get(k); as(x, () -> s.attendance().clockIn(x, null, null, "Demo")); }
    }

    // ---- maintenance: residents' requests, a community one, a purchase with a quotation waiting -----------------------------------------------------
    void maintenance() {
        Caller admin = who.get("admin"), plumber = who.get("plumber"), fm = who.get("fm");
        Caller o1 = owner(1), o3 = owner(3), o7 = owner(7);
        Ticket leak = as(o1, () -> s.tickets().raise(o1, new TicketService.RaiseTicket(null, "Leak under the kitchen sink", "Water collects in the cabinet", null, "Unit", null, "Plumbing", null, "High", "Morning", null)));
        as(plumber, () -> s.tickets().comment(plumber, leak.id(), "Coming at 11 with a new washer", "Public"));
        Ticket w = as(plumber, () -> s.tickets().changeStatus(plumber, leak.id(), leak.version(), TicketStatus.IN_PROGRESS, null));
        Ticket d = as(plumber, () -> s.tickets().changeStatus(plumber, leak.id(), w.version(), TicketStatus.COMPLETED, null));
        as(o1, () -> s.tickets().changeStatus(o1, leak.id(), d.version(), TicketStatus.CLOSED, null));
        as(o1, () -> s.tickets().rate(o1, leak.id(), 5));
        Ticket tap = as(o3, () -> s.tickets().raise(o3, new TicketService.RaiseTicket(null, "Garden tap dripping", null, null, "Unit", null, "Plumbing", null, "Medium", null, null)));
        as(plumber, () -> s.tickets().changeStatus(plumber, tap.id(), tap.version(), TicketStatus.IN_PROGRESS, null));
        as(o7, () -> s.tickets().raise(o7, new TicketService.RaiseTicket(null, "Bedroom light flickers", "Since the power cut", null, "Unit", null, "Electrical", null, "Low", "Evening", null)));
        UUID ecTask = taskType(admin, "EC Maintenance");
        as(fm, () -> s.tickets().raise(fm, new TicketService.RaiseTicket(ecTask, "Street light out near Gate 2", null, null, "Community", "Gate 2, lane C", "Electrical", null, "Medium", null, null)));
        UUID purchase = taskType(admin, "Purchase");
        if (purchase != null) {
            Ticket pump = as(admin, () -> s.tickets().raise(admin, new TicketService.RaiseTicket(purchase, "Replace the borewell pump", "The old pump trips every evening", null, "Community",
                "Pump room", "MEP", null, "High", null, null)));
            Ticket fin = as(admin, () -> s.tickets().edit(admin, pump.id(), pump.version(), new Ticket.Changes(null, null, null, null, null, null, null, null, null, null, true, null)));
            var q1 = as(admin, () -> s.quotations().add(admin, fin.id(), new QuotationService.AddDocument("Quotation", "Aqua Pumps", new BigDecimal("42000"), "Extra", new BigDecimal("18"), today.minusDays(2), "3 HP, 2-year warranty")));
            as(admin, () -> s.quotations().add(admin, fin.id(), new QuotationService.AddDocument("Quotation", "Deccan Motors", new BigDecimal("46500"), "Extra", new BigDecimal("18"), today.minusDays(1), "3 HP")));
            as(admin, () -> s.quotations().select(admin, q1.id(), q1.version()));
        }
    }

    UUID taskType(Caller admin, String name) {
        return as(admin, () -> s.jdbc().query("SELECT id FROM maintenance.task_type WHERE name = :n", Map.of("n", name), (rs, i) -> rs.getObject("id", UUID.class))).stream().findFirst().orElse(null);
    }

    // ---- amenities -----------------------------------------------------------------------------------------------------------------------------------
    void amenities() {
        Caller admin = who.get("admin");
        var types = repo(AmenityResources.TYPES);
        var tiers = List.of(new com.communityos.api.amenity.domain.AmenityType.Tier(new BigDecimal("48"), new BigDecimal("100")), new com.communityos.api.amenity.domain.AmenityType.Tier(BigDecimal.ZERO, new BigDecimal("50")));
        Item<AmenityResources.TypeFields> hall = as(admin, () -> s.kit().create(admin, AmenityResources.TYPES, types, new AmenityResources.TypeFields("Clubhouse party hall", "🎉", "Clubhouse", true, null,
            new BigDecimal("5000"), "Per day / event", new BigDecimal("6000"), true, new BigDecimal("18"), "Exclusive", new BigDecimal("2000"), tiers, 24, 90, 1, "09:00–23:00", "Full day",
            "No loud music after 22:00", "Reservation required", List.of(), null, null, null, List.of(), List.of(), List.of())));
        Item<AmenityResources.TypeFields> guest = as(admin, () -> s.kit().create(admin, AmenityResources.TYPES, types, new AmenityResources.TypeFields("Guest room", "🛏️", "Clubhouse", true, null,
            new BigDecimal("1500"), "Per day / event", null, true, new BigDecimal("12"), "Exclusive", BigDecimal.ZERO, List.of(), 12, 60, 1, "12:00–11:00", "Full day",
            "Check-in 12:00, check-out 11:00", "Reservation required", List.of(), null, null, null, List.of(), List.of(), List.of())));
        int[][] plan = {{5, 6}, {9, 13}, {14, 20}};
        for (int[] p : plan) {
            UnitId u = new UnitId(unitIds.get(p[0]));
            as(admin, () -> s.bookings().book(admin, new BookingService.Book(hall.id(), u, today.plusDays(p[1]), null, "Cash", null, false, "Unit", null, false, null, Map.of())));
        }
        as(admin, () -> s.bookings().book(admin, new BookingService.Book(guest.id(), new UnitId(unitIds.get(12)), today.plusDays(3), null, "UPI", null, false, "Unit", null, false, null, Map.of())));
    }

    // ---- the gate --------------------------------------------------------------------------------------------------------------------------------------
    void gate() {
        Caller admin = who.get("admin"), o1 = owner(1), o2 = owner(2);
        as(o1, () -> s.gate().createPass(o1, new GateService.NewPass("Meera (sister)", null, null, "One-time", today, today.plusDays(1), null, null, List.of(), null, null, null, null, null, false, null, null)));
        as(o2, () -> s.gate().createPass(o2, new GateService.NewPass("Lakshmi (cook)", null, null, "Recurring", today, today.plusMonths(3), LocalTime.of(7, 0), LocalTime.of(10, 0),
            List.of("Mon", "Tue", "Wed", "Thu", "Fri", "Sat"), null, null, null, null, null, false, null, null)));
        as(o2, () -> s.gate().createPass(o2, new GateService.NewPass("Packers & Movers", null, null, "Goods", today.plusDays(2), today.plusDays(2), null, null, List.of(), "TS09AB1234", null,
            "Move out", 3, "Sofa and two cartons", true, "Sofa, 2 cartons", null)));
        as(admin, () -> s.gate().ask(admin, new GateService.Ask("Guest", "Mr. Venkat", null, null, "TS07CD5678", "Visit", new UnitId(unitIds.get(1)), "Main gate", null, null, null, null, null)));
    }

    // ---- notices, a poll, the forum ---------------------------------------------------------------------------------------------------------------------
    void comms() {
        Caller sec = who.get("secretary"), t = who.get("treasurer"), o4 = owner(4);
        as(sec, () -> s.notices().create(sec, new BroadcastService.Draft("Notice", "All residents", "Water supply interruption on Saturday",
            "<p>The overhead tank will be cleaned on Saturday from 10:00 to 14:00. Please store water.</p>", List.of(), List.of(), null, null, null, null, null, null, null, null, null), true, null));
        as(t, () -> s.notices().create(t, new BroadcastService.Draft("Announcement", "All residents", "October maintenance bills are out",
            "<p>Pay by the 15th to avoid the late fee. UPI and bank transfer are accepted.</p>", List.of(), List.of(), null, null, null, null, null, null, null, null, null), true, null));
        as(sec, () -> s.notices().create(sec, new BroadcastService.Draft("Poll", "Owners", "Diwali lighting budget", "<p>How much should we spend on lights this year?</p>", List.of(), List.of(),
            null, null, null, null, List.of("₹25,000", "₹40,000", "₹60,000"), false, today.plusDays(7), null, null), true, null));
        var topic = as(o4, () -> s.forum().start(o4, new ForumService.NewTopic("Pool timings in winter", "Amenities", "Discussion", List.of())));
        Caller o5 = owner(5);
        as(o5, () -> s.forum().reply(o5, topic.id, null, "<p>7 to 10 in the morning works for most of us.</p>"));
        as(sec, () -> s.forum().reply(sec, topic.id, null, "<p>We will take this up at the next EC meeting.</p>"));
    }

    // ---- documents ---------------------------------------------------------------------------------------------------------------------------------------
    void documents() {
        Caller admin = who.get("admin");
        var folders = repo(DocsResources.FOLDERS);
        var assoc = as(admin, () -> s.kit().create(admin, DocsResources.FOLDERS, folders, new DocsResources.FolderFields("Association", null, List.of())));
        var treasury = as(admin, () -> s.kit().create(admin, DocsResources.FOLDERS, folders, new DocsResources.FolderFields("Treasury", null, List.of("treasurer", "president"))));
        doc(admin, "bye-laws.pdf", "La Paloma bye-laws", "Association", "v3", "All owners", assoc.id());
        doc(admin, "agm-minutes.pdf", "AGM minutes (last year)", "Association", null, "Everyone", assoc.id());
        doc(admin, "budget.pdf", "Budget " + today.getYear() + "-" + (today.getYear() + 1) % 100, null, null, "Everyone", treasury.id());
    }
    void doc(Caller admin, String file, String title, String category, String edition, String access, UUID folder) {
        var f = as(admin, () -> s.files().upload(admin, new FileService.Upload(file, pdf(title), null)));
        as(admin, () -> s.documents().file(admin, f.id(), new DocumentService.Fields(title, category, edition, access, null, null, folder)));
    }
    /** A small valid PDF with one line of text. */
    static byte[] pdf(String text) {
        String t = text.replace("(", "").replace(")", "").replace("\\", "");
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

    // ---- Diwali ---------------------------------------------------------------------------------------------------------------------------------------
    LocalDate diwali() { LocalDate d = LocalDate.of(today.getYear(), 11, 8); return d.isBefore(today) ? today.plusDays(20) : d; }
    void cultural() {
        Caller c = who.get("cultural");
        var events = repo(CulturalResources.EVENTS);
        LocalDate day = diwali();
        var ev = as(c, () -> s.kit().create(c, CulturalResources.EVENTS, events, new CulturalResources.EventFields("Diwali Festival", "Festival", day, day.plusDays(1), LocalTime.of(18, 0),
            LocalTime.of(22, 0), null, null, "Clubhouse lawn", "Open", "Published", "Large", null, new BigDecimal("150000"), null, new BigDecimal("200000"), null, "Cultural",
            new BigDecimal("25000"), null, null, null, null, null, null, null, "Yes", "Yes", "Yes", "Yes", "Yes", "Yes", "Everyone", null, null,
            "<p>Lights, rangoli, a cultural evening and dinner for all families.</p>")));
        var seva = repo(CulturalResources.SEVAS);
        as(c, () -> s.kit().create(c, CulturalResources.SEVAS, seva, new CulturalResources.SevaFields(ev.id(), "Rangoli team", day, LocalTime.of(15, 0), LocalTime.of(18, 0), 6, "Bring your own colours")));
        int[] amounts = {1001, 2501, 5001, 1101, 2001, 1501};
        for (int i = 0; i < amounts.length; i++) {
            Caller o = owner(i + 1); int ii = i;
            var p = as(o, () -> s.donations().pledge(o, new DonationService.Pledge(ev.id(), null, null, "Donation", null, new BigDecimal(amounts[ii]), null, null, null, false, null, null, null, null, null)));
            if (i < 4) as(c, () -> s.donations().receive(c, p.id, p.version, ii % 2 == 0 ? "UPI" : "Cash", null));
        }
        as(c, () -> s.donations().record(c, new DonationService.Pledge(ev.id(), "Sri Balaji Jewellers", null, "Sponsorship", "Sound & lights", new BigDecimal("15000"), today, "Bank transfer", "NEFT 7781",
            false, null, null, null, null, null), true));
        as(c, () -> s.expenses().raise(c, ev.id(), new ExpenseService.Fields("Lights and decoration", "Decoration", "Bright Lights & Co", new BigDecimal("38000"), null, today, "Cultural", "Advance on order")));
    }

    // ---- the cash book ------------------------------------------------------------------------------------------------------------------------------
    void finance() {
        Caller t = who.get("treasurer");
        cash(t, today.minusDays(18), "Security agency - September", "Security", "Eagle Security Services", "42000", null, null, "Bank transfer");
        cash(t, today.minusDays(12), "Common-area electricity - September", "Electricity", "TSSPDCL", "18450", null, null, "Bank transfer");
        cash(t, today.minusDays(9), "Diesel for the DG set", "Diesel", "HP Fuel Point", null, "11500", "0", "UPI");
        cash(t, today.minusDays(4), "Pest control - quarterly", "AMC & infrastructure", "PestAway", null, "8000", "2", "Bank transfer");
    }
    void cash(Caller t, LocalDate date, String what, String category, String vendor, String amount, String base, String tds, String mode) {
        Books.Entry e = new Books.Entry();
        e.date = date; e.type = "Debit"; e.description = what; e.category = category; e.vendor = vendor; e.mode = mode; e.module = "Utilities".equals(category) || "Electricity".equals(category) || "Diesel".equals(category) ? "Utilities" : "Maintenance"; e.account = "Main account";
        if (base != null) { e.baseAmount = new BigDecimal(base); e.gstRate = new BigDecimal("18"); e.tdsRate = new BigDecimal(tds); if (!"0".equals(tds)) e.tdsSection = "194C"; }
        else e.amount = new BigDecimal(amount);
        as(t, () -> s.cash().record(t, e));
    }

    // ---- governance -----------------------------------------------------------------------------------------------------------------------------------
    void governance() {
        Caller sec = who.get("secretary");
        var agm = as(sec, () -> s.meetings().create(sec, new MeetingService.Fields("Annual General Meeting", "General body / AGM", today.minusDays(21), LocalTime.of(10, 0), LocalTime.of(13, 0),
            "Clubhouse hall", "Scheduled", "Published to residents", "<ol><li>Accounts for the year</li><li>Budget</li><li>Election of the EC</li></ol>", null, null)));
        as(sec, () -> s.meetings().update(sec, agm.id, agm.version, new MeetingService.Fields("Annual General Meeting", "General body / AGM", today.minusDays(21), LocalTime.of(10, 0), LocalTime.of(13, 0),
            "Clubhouse hall", "Completed", "Published to residents", "<ol><li>Accounts for the year</li><li>Budget</li><li>Election of the EC</li></ol>",
            "<p>The accounts were adopted. The budget was approved with a 5% increase in maintenance. The EC was re-elected.</p>", null)));
        as(sec, () -> s.meetings().create(sec, new MeetingService.Fields("EC meeting - November", "Executive Committee", today.plusDays(9), LocalTime.of(19, 0), LocalTime.of(20, 30),
            "Clubhouse office", "Scheduled", "Internal (committee only)", "<ul><li>Pump replacement quotations</li><li>Diwali arrangements</li></ul>", null, null)));
        var b = as(sec, () -> s.ballots().create(sec, new BallotService.Fields("Install solar panels on the clubhouse roof", "<p>Estimated cost ₹6.5 lakh from the sinking fund; about ₹9,000 a month saved.</p>",
            "Resolution", null, today, today.plusDays(7), new BigDecimal("50"), new BigDecimal("50"), agm.id)));
        as(sec, () -> s.ballots().open(sec, b.id, b.version));
    }

    // ---- vendors and the directory ----------------------------------------------------------------------------------------------------------------------
    void vendors() {
        Caller admin = who.get("admin");
        var vendors = repo(VendorResources.VENDORS); var lines = repo(VendorResources.SERVICE_LINES);
        String[][] list = {{"Eagle Security Services", "Security", "Contract", "Security", "+914023450001", "12"}, {"GreenLeaf Landscapes", "Landscaping", "Contract", "Landscaping", "+914023450002", "6"},
            {"Aqua Pumps", "Maintenance", "AMC", "Plumbing", "+914023450003", "2"}, {"Otis Elevators", "Lift / AMC", "AMC", "Lift", "+914023450004", "1"}};
        for (String[] v : list) {
            var item = as(admin, () -> s.kit().create(admin, VendorResources.VENDORS, vendors, new VendorResources.VendorFields(v[0], v[1], null, v[2], v[3], v[4], null, "Hyderabad",
                today.plusMonths(8), null)));
            as(admin, () -> s.kit().create(admin, VendorResources.SERVICE_LINES, lines, new VendorResources.ServiceLineFields(item.id(), v[3], Integer.parseInt(v[5]), "Day", null)));
        }
        Caller o6 = owner(6), o8 = owner(8), o9 = owner(9);
        var raju = as(o6, () -> s.directory().add(o6, new DirectoryService.ContactFields("Raju (electrician)", "Electrician", "+91 98480 11223", "Gachibowli", "₹400 a visit", "Very prompt", null, null, null)));
        var anand = as(o8, () -> s.directory().add(o8, new DirectoryService.ContactFields("Anand (car cleaning)", "Car cleaning", "+91 98480 33445", null, "₹800 a month", null, null, null, null)));
        as(o9, () -> s.directory().add(o9, new DirectoryService.ContactFields("Sunita (cook)", "Cook", "+91 98480 55667", "Kondapur", null, "South Indian and North Indian", null, null, null)));
        as(o6, () -> s.directory().review(o6, raju.id, new DirectoryService.ReviewFields(5, "Fixed our inverter in 20 minutes", "Yes")));
        as(o8, () -> s.directory().review(o8, raju.id, new DirectoryService.ReviewFields(4, null, "Yes")));
        as(o9, () -> s.directory().review(o9, anand.id, new DirectoryService.ReviewFields(3, "Good, but sometimes late", "No")));
    }

    // ---- assets -----------------------------------------------------------------------------------------------------------------------------------------
    void assets() {
        Caller fm = who.get("fm"), mep = who.get("mep");
        var eq = repo(AssetResources.EQUIPMENT);
        String[][] list = {{"STP blower A", "STP", "Blower", "Working"}, {"STP blower B", "STP", "Blower", "Standby"}, {"WTP feed pump", "WTP", "Pump", "Working"},
            {"Borewell pump 1", "Pump room", "Pump", "Needs attention"}, {"DG set 125 kVA", "DG room", "Generator", "Working"}, {"Lift - clubhouse", "Clubhouse", "Lift", "Working"},
            {"Fire pump", "Pump room", "Pump", "Working"}, {"Street lights - lane C", "Street / roads", "Street light", "Needs attention"}};
        UUID borewell = null;
        for (String[] a : list) {
            var item = as(fm, () -> s.kit().create(fm, AssetResources.EQUIPMENT, eq, new AssetResources.EquipmentFields(a[0], a[1], a[2], null, List.of(), null, a[2].equals("Street light") ? 18 : 1,
                Map.of(), null, null, null, null, null, null, today.minusYears(3), today.plusMonths(6), null, null, null, today.minusMonths(2), today.plusMonths(1), "Working",
                a[2].equals("Street light") ? 3 : 0, List.of(), null, null, null, null, null, null, null)));
            if (!"Working".equals(a[3])) { String cond = a[3]; as(fm, () -> s.assets().condition(fm, item.id(), today.minusDays(2), cond, "Inspection", "Found on the weekly round", null)); }
            if (a[0].startsWith("Borewell")) borewell = item.id();
        }
        if (borewell == null) throw new IllegalStateException("no borewell pump");
        var inv = repo(AssetResources.INVENTORY);
        String[][] stock = {{"Softener salt", "Chemicals", "Kg", "50", "200", "150"}, {"Chlorine liquid", "Chemicals", "Litres", "20", "60", "22"}, {"LED bulb 9 W", "Electrical", "Nos", "20", "50", "12"},
            {"PVC elbow 1 inch", "Plumbing", "Nos", "10", "40", "6"}, {"Garden hose 30 m", "Gardening", "Nos", "1", "3", "0"}};
        for (String[] x : stock) {
            var item = as(fm, () -> s.kit().create(fm, AssetResources.INVENTORY, inv, new AssetResources.InventoryFields(x[0], x[1], "Store room", x[2], new BigDecimal(x[3]), null, null, null, null, null)));
            as(fm, () -> s.assets().move(fm, item.id(), "Received", new BigDecimal(x[4]), today.minusDays(20), null, "Local supplier", null));
            BigDecimal used = new BigDecimal(x[5]);
            if (used.signum() > 0) as(fm, () -> s.assets().move(fm, item.id(), "Issued", used, today.minusDays(3), null, null, "Used this month"));
        }
        var plant = repo(AssetResources.PLANT_LOGS);
        BigDecimal bh = new BigDecimal("15200"), wtp = new BigDecimal("8800"), stp = new BigDecimal("4100");
        for (int d = 7; d >= 1; d--) {
            BigDecimal b1 = bh, w1 = wtp, s1 = stp, b2 = bh.add(BigDecimal.valueOf(180 + d * 7)), w2 = wtp.add(BigDecimal.valueOf(160 + d * 5)), s2 = stp.add(BigDecimal.valueOf(120 + d * 3));
            int dd = d;
            as(mep, () -> s.kit().create(mep, AssetResources.PLANT_LOGS, plant, new AssetResources.PlantLogFields(today.minusDays(dd), b1, b2, null, w1, w2, null, s1, s2, null,
                new BigDecimal("400"), new BigDecimal("25"), new BigDecimal("60"), new BigDecimal("3.5"), null)));
            bh = b2; wtp = w2; stp = s2;
        }
        var dg = repo(AssetResources.DG_FUEL);
        as(mep, () -> s.kit().create(mep, AssetResources.DG_FUEL, dg, new AssetResources.DgFuelFields(today.minusDays(9), "DG set 125 kVA", new BigDecimal("2140"), new BigDecimal("48210"),
            new BigDecimal("120"), new BigDecimal("95.80"), null, false, "HP Fuel Point", "HP-5512", null, null)));
        var bills = repo(AssetResources.ELECTRICITY_BILLS);
        as(fm, () -> s.kit().create(fm, AssetResources.ELECTRICITY_BILLS, bills, new AssetResources.ElectricityBillFields("Common area", "CA-112233", today.minusMonths(1).getMonth() + " " + today.getYear(),
            today.minusDays(15), today.minusDays(1), new BigDecimal("2210"), null, null, null, null, null, null, null, null, new BigDecimal("18450"), "Paid", today.minusDays(12), "Main account", "NEFT 55112", null, null)));
        as(fm, () -> s.kit().create(fm, AssetResources.ELECTRICITY_BILLS, bills, new AssetResources.ElectricityBillFields("STP", "STP-4455", today.minusMonths(1).getMonth() + " " + today.getYear(),
            today.minusDays(6), today.plusDays(9), new BigDecimal("980"), null, null, null, null, null, null, null, null, new BigDecimal("8120"), "Unpaid", null, null, null, null, null)));
        var audits = repo(AssetResources.AUDITS);
        as(fm, () -> s.kit().create(fm, AssetResources.AUDITS, audits, new AssetResources.AuditFields("Swimming pool", today.minusMonths(5), "Aqua Labs", null, "Pass with observations",
            new BigDecimal("86"), null, "<p>pH slightly high</p>", "<p>Dosing adjusted</p>", new BigDecimal("6"), null, null, "Published")));
        as(fm, () -> s.kit().create(fm, AssetResources.AUDITS, audits, new AssetResources.AuditFields("Fire safety", today.minusMonths(12).minusDays(10), "SafeFire Consultants", null, "Pass",
            new BigDecimal("92"), null, null, null, new BigDecimal("12"), null, null, "Published")));
        as(fm, () -> s.kit().create(fm, AssetResources.AUDITS, audits, new AssetResources.AuditFields("Lift", today.minusMonths(2), "Otis Elevators", null, "Pass", null, null, null, null,
            new BigDecimal("6"), null, null, "Internal")));
    }

    // ---- report schedules -------------------------------------------------------------------------------------------------------------------------------
    void reports() {
        Caller admin = who.get("admin");
        var sched = repo(ReportResources.SCHEDULES);
        List<UUID> treasurerRole = as(admin, () -> s.jdbc().query("SELECT id FROM identity.role WHERE code IN ('treasurer', 'president')", Map.of(), (rs, i) -> rs.getObject("id", UUID.class)));
        List<UUID> fmRole = as(admin, () -> s.jdbc().query("SELECT id FROM identity.role WHERE code IN ('facility_manager')", Map.of(), (rs, i) -> rs.getObject("id", UUID.class)));
        as(admin, () -> s.kit().create(admin, ReportResources.SCHEDULES, sched, new ReportResources.ScheduleFields("Dues outstanding - every Monday", "dues", "asof", "Detailed", "Weekly",
            LocalTime.of(8, 0), "Monday", null, List.of("In-app", "Email"), "Roles", treasurerRole, List.of(), List.of(), null, null, List.of(), true, true, true, null, null, false, true)));
        as(admin, () -> s.kit().create(admin, ReportResources.SCHEDULES, sched, new ReportResources.ScheduleFields("Maintenance tasks - daily", "tasks", "yesterday", "Summary", "Daily",
            LocalTime.of(7, 30), null, null, List.of("In-app"), "Roles", fmRole, List.of(), List.of(), null, null, List.of(), true, false, true, null, null, true, true)));
        as(admin, () -> s.kit().create(admin, ReportResources.SCHEDULES, sched, new ReportResources.ScheduleFields("Tomorrow's bookings", "bookings", "tomorrow", "Detailed", "Daily",
            LocalTime.of(18, 0), null, null, List.of("In-app"), "All villas", List.of(), List.of(), List.of(), null, null, List.of(), true, false, true, null, null, true, true)));
    }

    // ---- helpers --------------------------------------------------------------------------------------------------------------------------------------
    <F extends Record> JdbcResourceRepository<F> repo(Resource<F> r) { return new JdbcResourceRepository<>(r.table(), s.jdbc(), s.json()); }
    static <T> T as(Caller c, Supplier<T> work) { return CallerHolder.runAs(c, work); }
}
