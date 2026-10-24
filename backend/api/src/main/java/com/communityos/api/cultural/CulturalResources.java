package com.communityos.api.cultural;

import com.communityos.api.cultural.adapter.JdbcCulturalStore;
import com.communityos.api.cultural.application.CulturalPolicy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.Caller;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The cultural registers (resource kit): events (with their totals worked out from donations and expenses), the programme, seva slots,
 * offerings, brochure pages and photos. Sign-ups, reservations and the budget credit are commands (SignupService, DonationService,
 * ExpenseService), so those columns are the server's here.
 */
public final class CulturalResources {
    private CulturalResources() {}
    static boolean manager(Caller c) { return CulturalPolicy.manager(c); }
    static final List<String> YES_NO = List.of("Yes", "No");
    static void times(LocalTime a, LocalTime b) { Checks.rule(a == null || b == null || !b.isBefore(a), "bad-times", "The end time is before the start time"); }
    static UUID event(UUID id) { Checks.rule(id != null, "event-required", "Which event?"); return id; }

    // ---- events ----------------------------------------------------------------------------------------------------------------------------------
    public record EventFields(String name, String type, LocalDate startDate, LocalDate endDate, LocalTime startTime, LocalTime endTime, String repeat, LocalDate repeatUntil,
                              String venue, String status, String visibility, String size, String series, BigDecimal budget, BigDecimal historicalActual, BigDecimal targetCollection,
                              String upiId, String fund, BigDecimal finalOver, String upiPayee, String gateway, String programmeStatus, BigDecimal defaultPeople, String brochureStatus,
                              Instant brochurePublishedAt, BigDecimal brochureVersion, String showBrochure, String showProgramme, String showOfferings, String showVolunteers,
                              String showDonations, String showPhotos, String photosBy, String offeringsTitle, String offeringsIntro, String description) {}
    public static final Resource<EventFields> EVENTS = new Resource<>(
        new ResourceTable<>("culturalEvents", "cultural/events", "cultural.event", EventFields.class, "r.start_date DESC NULLS LAST, r.name")
            .server("creditedAmount", Kind.MONEY).server("creditedAt", Kind.TIMESTAMP).who("creditedBy", "credited_by_id", false).server("creditNote", Kind.TEXT)
            .computed("collected", Kind.MONEY, JdbcCulturalStore.COLLECTED).computed("pledged", Kind.MONEY, JdbcCulturalStore.PLEDGED)
            .computed("families", Kind.INT, JdbcCulturalStore.FAMILIES).computed("donors", Kind.INT, JdbcCulturalStore.DONORS).computed("spent", Kind.MONEY, JdbcCulturalStore.SPENT),
        new ResourceRules<>() {
            @Override public Spec<EventFields> readScope(Caller c) {
                return c.isResident() ? Spec.eq("r.visibility", "Published", (f) -> "Published".equals(f.visibility())) : CulturalPolicy.events(c, "r");
            }
            @Override public boolean mayWrite(Caller c) { return manager(c); }
            @Override public EventFields validate(Caller c, EventFields f, EventFields old) {
                String name = Checks.required(f.name(), "Name");
                Checks.rule(name.length() >= 2 && name.length() <= 200, "bad-name", "An event name has 2 to 200 characters");   // the table's own rule, said here
                Checks.present(f.type(), "Type"); Checks.present(f.startDate(), "Start date");
                Checks.rule(f.repeatUntil() == null || f.startDate() == null || !f.repeatUntil().isBefore(f.startDate()), "bad-repeat", "It repeats until a date before it starts");
                Checks.oneOf(f.type(), "Type", List.of("Festival", "Cultural programme", "Sports / games", "Celebration", "Other"));
                Checks.oneOf(f.repeat(), "Repeat", List.of("Does not repeat", "Weekly", "Every 2 weeks", "Monthly (same date)"));
                String status = f.status() == null ? "Planning" : Checks.oneOf(f.status(), "Status", List.of("Planning", "Open", "Completed", "Cancelled"));
                String vis = f.visibility() == null ? "Internal" : Checks.oneOf(f.visibility(), "Visibility", List.of("Internal", "Published"));
                Checks.oneOf(f.size(), "Size", List.of("Small", "Medium", "Large"));
                Checks.oneOf(f.programmeStatus(), "Programme", List.of("Draft", "Published")); Checks.oneOf(f.brochureStatus(), "Brochure", List.of("Draft", "Published"));
                for (String y : new String[] {f.showBrochure(), f.showProgramme(), f.showOfferings(), f.showVolunteers(), f.showDonations(), f.showPhotos()}) Checks.oneOf(y, "Show", YES_NO);
                Checks.oneOf(f.photosBy(), "Photos by", List.of("Everyone", "Committee only"));
                Checks.rule(f.endDate() == null || f.startDate() == null || !f.endDate().isBefore(f.startDate()), "bad-dates", "The event ends before it starts");
                for (BigDecimal b : new BigDecimal[] {f.budget(), f.historicalActual(), f.targetCollection(), f.finalOver(), f.defaultPeople()}) Checks.nonNegative(b, "Amount");
                Checks.rule(f.upiId() == null || f.upiId().isBlank() || f.upiId().matches("[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}"), "bad-upi", "A UPI id looks like name@bank");
                return new EventFields(name, f.type(), f.startDate(), f.endDate(), f.startTime(), f.endTime(), f.repeat(), f.repeatUntil(), Checks.text(f.venue(), "Venue", 200), status, vis,
                    f.size(), f.series(), f.budget(), f.historicalActual(), f.targetCollection(), f.upiId(), f.fund(), f.finalOver(), f.upiPayee(), f.gateway(), f.programmeStatus(),
                    f.defaultPeople(), f.brochureStatus(), f.brochurePublishedAt(), f.brochureVersion(), f.showBrochure(), f.showProgramme(), f.showOfferings(), f.showVolunteers(),
                    f.showDonations(), f.showPhotos(), f.photosBy(), f.offeringsTitle(), f.offeringsIntro(), Checks.text(f.description(), "Description", 20_000));
            }
            @Override public String label(EventFields f) { return f.name(); }
        });

    // ---- programme, seva, offerings ------------------------------------------------------------------------------------------------------------------
    public record ProgramFields(UUID eventId, String title, LocalDate date, LocalTime startTime, LocalTime endTime, String lead, String venue, Integer capacity, Integer peoplePerUnit, String notes) {}
    public static final Resource<ProgramFields> PROGRAMS = new Resource<>(
        new ResourceTable<>("culturalPrograms", "cultural/programme", "cultural.program", ProgramFields.class, "r.date NULLS LAST, r.start_time NULLS LAST").server("participants", Kind.JSON).filterBy("eventId"),
        new ResourceRules<>() {
            @Override public Spec<ProgramFields> readScope(Caller c) { return CulturalPolicy.ofEvents(c, "r.event_id"); }
            @Override public boolean mayWrite(Caller c) { return manager(c); }
            @Override public ProgramFields validate(Caller c, ProgramFields f, ProgramFields old) {
                Checks.present(f.date(), "Date"); times(f.startTime(), f.endTime());
                return new ProgramFields(event(f.eventId()), Checks.required(f.title(), "Title"), f.date(), f.startTime(), f.endTime(), f.lead(), f.venue(), Checks.nonNegative(f.capacity(), "Capacity"),
                    Checks.nonNegative(f.peoplePerUnit(), "People per unit"), Checks.text(f.notes(), "Notes", 4000));
            }
            @Override public String label(ProgramFields f) { return f.title(); }
        });
    public record SevaFields(UUID eventId, String title, LocalDate date, LocalTime startTime, LocalTime endTime, Integer needed, String description) {}
    public static final Resource<SevaFields> SEVAS = new Resource<>(
        new ResourceTable<>("culturalSevas", "cultural/seva", "cultural.seva", SevaFields.class, "r.date NULLS LAST, r.start_time NULLS LAST").server("volunteers", Kind.JSON).filterBy("eventId"),
        new ResourceRules<>() {
            @Override public Spec<SevaFields> readScope(Caller c) { return CulturalPolicy.ofEvents(c, "r.event_id"); }
            @Override public boolean mayWrite(Caller c) { return manager(c); }
            @Override public SevaFields validate(Caller c, SevaFields f, SevaFields old) {
                Checks.present(f.date(), "Date"); Checks.rule(f.needed() != null && f.needed() > 0, "required", "How many volunteers are needed?"); times(f.startTime(), f.endTime());
                return new SevaFields(event(f.eventId()), Checks.required(f.title(), "Title"), f.date(), f.startTime(), f.endTime(), Checks.nonNegative(f.needed(), "Volunteers needed"),
                    Checks.text(f.description(), "Description", 4000));
            }
            @Override public String label(SevaFields f) { return f.title(); }
        });
    public record OfferingFields(UUID eventId, String title, String day, String kind, BigDecimal pledgeValue, String description) {}
    public static final Resource<OfferingFields> OFFERINGS = new Resource<>(
        new ResourceTable<>("culturalOfferings", "cultural/offerings", "cultural.offering", OfferingFields.class, "r.day NULLS LAST, r.title")
            .server("reservedBy", Kind.TEXT).server("reservedUnit", Kind.TEXT).server("reservedAt", Kind.TIMESTAMP).server("donationId", Kind.UUID).filterBy("eventId"),
        new ResourceRules<>() {
            @Override public Spec<OfferingFields> readScope(Caller c) { return CulturalPolicy.ofEvents(c, "r.event_id"); }
            @Override public boolean mayWrite(Caller c) { return manager(c); }
            @Override public OfferingFields validate(Caller c, OfferingFields f, OfferingFields old) {
                String kind = f.kind() == null ? "Community pool" : Checks.oneOf(f.kind(), "Kind", List.of("Fixed slot", "Community pool"));
                return new OfferingFields(event(f.eventId()), Checks.required(f.title(), "Title"), f.day(), kind, Checks.nonNegative(f.pledgeValue(), "Pledge value"), Checks.text(f.description(), "Description", 4000));
            }
            @Override public boolean mayChange(Caller c, Item<OfferingFields> it) { return it.server("donationId") == null || manager(c); }
            @Override public String label(OfferingFields f) { return f.title(); }
        });

    // ---- brochure and photos -----------------------------------------------------------------------------------------------------------------------
    public record BrochureFields(UUID eventId, Integer order, String kind, String heading, String body, String layout, UUID fileId, String thumb, String imageName) {}
    public static final Resource<BrochureFields> BROCHURE = new Resource<>(
        new ResourceTable<>("culturalBrochure", "cultural/brochure", "cultural.brochure_page", BrochureFields.class, "r.order_value NULLS LAST", Map.of("order", "order_value")).filterBy("eventId"),
        new ResourceRules<>() {
            @Override public Spec<BrochureFields> readScope(Caller c) { return CulturalPolicy.ofEvents(c, "r.event_id"); }
            @Override public boolean mayWrite(Caller c) { return manager(c); }
            @Override public BrochureFields validate(Caller c, BrochureFields f, BrochureFields old) {
                Checks.rule(f.thumb() == null || f.thumb().length() <= 200_000, "thumb-too-big", "The preview picture is too large");
                return new BrochureFields(event(f.eventId()), f.order(), Checks.oneOf(f.kind(), "Kind", List.of("Cover", "Text", "Programme", "Offerings", "Photos", "Contact")),
                    Checks.text(f.heading(), "Heading", 200), Checks.text(f.body(), "Body", 20_000), Checks.oneOf(f.layout(), "Layout", List.of("Picture on top", "Picture left", "Picture right")),
                    f.fileId(), f.thumb(), Checks.text(f.imageName(), "Picture name", 255));
            }
        });
    public record PhotoFields(UUID eventId, String caption, LocalDate takenOn, String fileName, UUID fileId, String thumb) {}
    public static final Resource<PhotoFields> PHOTOS = new Resource<>(
        new ResourceTable<>("culturalPhotos", "cultural/photos", "cultural.photo", PhotoFields.class, "r.taken_on DESC NULLS LAST, r.created_at DESC").who("uploadedBy").filterBy("eventId"),
        new ResourceRules<>() {
            @Override public Spec<PhotoFields> readScope(Caller c) { return CulturalPolicy.ofEvents(c, "r.event_id"); }
            @Override public boolean mayWrite(Caller c) { return CulturalPolicy.member(c); }
            @Override public boolean mayChange(Caller c, Item<PhotoFields> it) { return manager(c) || ResourceRules.mine(c, it, "uploadedById"); }
            @Override public PhotoFields validate(Caller c, PhotoFields f, PhotoFields old) {
                Checks.rule(old == null || old.fileId() == null || old.fileId().equals(f.fileId()) || manager(c), "file-fixed", "Add a new photo instead of replacing the picture");
                Checks.rule(f.thumb() == null || f.thumb().length() <= 200_000, "thumb-too-big", "The thumbnail is too large");
                return new PhotoFields(event(old == null ? f.eventId() : old.eventId()), Checks.text(f.caption(), "Caption", 500), f.takenOn(), Checks.text(f.fileName(), "File name", 255), f.fileId(), f.thumb());
            }
        });

    public static List<Resource<?>> all() { return List.of(EVENTS, PROGRAMS, SEVAS, OFFERINGS, BROCHURE, PHOTOS); }
}
