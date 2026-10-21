package com.communityos.api.maintenance;

import com.communityos.api.maintenance.application.TicketRules;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The maintenance registers served by the resource kit, each with its request type (exactly the fields a caller may send) and its rules.
 * The workflows (tickets, comments, quotations / invoices and their approvals, field staff) have their own services.
 */
public final class MaintenanceResources {
    private MaintenanceResources() {}

    static boolean manageTypes(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_TICKET_TYPES); }
    static boolean committee(Caller c) { return c.isSuperAdmin() || c.category() == Caller.Category.EC; }

    // ---- task types -------------------------------------------------------------------------------------------------------------------------
    public record TaskTypeFields(String name, String icon, String creatorScope, String assignmentMode, String quotationStage, String ecApprovalStage, String treasurerStage,
                                 String invoiceStage, String paymentStage, boolean residentVisible, boolean residentDefault, boolean active) {}
    static final List<String> STAGES = List.of("No", "Optional", "Yes");
    public static final Resource<TaskTypeFields> TASK_TYPES = new Resource<>(
        new ResourceTable<>("taskTypes", "maintenance/task-types", "maintenance.task_type", TaskTypeFields.class, "r.name"),
        new ResourceRules<>() {
            @Override public Spec<TaskTypeFields> readScope(Caller c) {
                if (c.category() == Caller.Category.Vendor) return Spec.none();
                return c.isResident() ? Spec.eq("r.resident_visible", true, TaskTypeFields::residentVisible) : Spec.all();
            }
            @Override public boolean mayWrite(Caller c) { return manageTypes(c); }
            @Override public TaskTypeFields validate(Caller c, TaskTypeFields f, TaskTypeFields old) {
                String name = Checks.required(f.name(), "Name");
                Checks.rule(name.length() >= 2 && name.length() <= 60, "bad-name", "A name has 2 to 60 characters");
                Checks.requiredOneOf(f.creatorScope(), "Who raises it", List.of("Resident", "EC / Staff", "Anyone"));
                Checks.requiredOneOf(f.assignmentMode(), "Assignment", List.of("Role queue (staff accepts)", "Direct assign"));
                for (String s : new String[] {f.quotationStage(), f.ecApprovalStage(), f.treasurerStage(), f.invoiceStage(), f.paymentStage()}) Checks.oneOf(s, "Stage", STAGES);
                Checks.rule(!f.residentDefault() || f.residentVisible(), "default-hidden", "The residents' default type must be shown to residents");
                return new TaskTypeFields(name, Checks.text(f.icon(), "Icon", 8), f.creatorScope(), f.assignmentMode(), f.quotationStage(), f.ecApprovalStage(), f.treasurerStage(),
                    f.invoiceStage(), f.paymentStage(), f.residentVisible(), f.residentDefault(), f.active());
            }
            @Override public boolean deletable(TaskTypeFields f) { return false; }       // tickets point at it: switch it off instead
            @Override public String label(TaskTypeFields f) { return f.name(); }
        });

    // ---- category coverage ------------------------------------------------------------------------------------------------------------------
    public record CategoryFields(String category, List<String> subCategories, String vendor, String assetLink, List<String> coordinator, String notes) {}
    public static final Resource<CategoryFields> CATEGORIES = new Resource<>(
        new ResourceTable<>("categoryMap", "maintenance/categories", "maintenance.category_coverage", CategoryFields.class, "r.category"),
        new ResourceRules<>() {
            @Override public boolean mayWrite(Caller c) { return manageTypes(c); }
            @Override public CategoryFields validate(Caller c, CategoryFields f, CategoryFields old) {
                return new CategoryFields(Checks.required(f.category(), "Category"), Checks.list(f.subCategories()), Checks.text(f.vendor(), "Vendor", 200),
                    Checks.text(f.assetLink(), "Asset", 200), Checks.list(f.coordinator()), Checks.text(f.notes(), "Notes", 2000));
            }
            @Override public String label(CategoryFields f) { return f.category(); }
        });

    // ---- quick phrases ----------------------------------------------------------------------------------------------------------------------
    public record PhraseFields(String phrase, String category) {}
    public static final Resource<PhraseFields> PHRASES = new Resource<>(
        new ResourceTable<>("quickPhrases", "maintenance/quick-phrases", "maintenance.quick_phrase", PhraseFields.class, "r.created_at"),
        new ResourceRules<>() {
            @Override public boolean mayWrite(Caller c) { return manageTypes(c); }
            @Override public PhraseFields validate(Caller c, PhraseFields f, PhraseFields old) {
                return new PhraseFields(Checks.text(Checks.required(f.phrase(), "Phrase"), "Phrase", 120), Checks.required(f.category(), "Category"));
            }
            @Override public String label(PhraseFields f) { return f.phrase(); }
        });

    // ---- final approvers (and other named approver lists) --------------------------------------------------------------------------------------
    public record ApproverFields(String name, List<String> roles) {}
    public static final Resource<ApproverFields> APPROVERS = new Resource<>(
        new ResourceTable<>("approverSettings", "maintenance/approver-settings", "maintenance.approver_setting", ApproverFields.class, "r.name"),
        new ResourceRules<>() {
            @Override public Spec<ApproverFields> readScope(Caller c) { return ResourceRules.only(ResourceRules::staffOrCommittee, c); }
            @Override public boolean mayWrite(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_ROLES); }
            @Override public ApproverFields validate(Caller c, ApproverFields f, ApproverFields old) {
                Checks.rule(old == null || old.name().equals(f.name()), "fixed-name", "The name of an approver list does not change");
                Checks.rule(!Checks.list(f.roles()).isEmpty(), "roles-required", "Choose at least one role");
                return new ApproverFields(Checks.required(f.name(), "Name"), List.copyOf(f.roles()));
            }
            @Override public boolean deletable(ApproverFields f) { return false; }
            @Override public String label(ApproverFields f) { return f.name(); }
        });

    // ---- wishes (the community's wish list) ---------------------------------------------------------------------------------------------------
    public record WishFields(String title, String description, String category, String location, UUID unitId, String status, BigDecimal estimate, String decisionNote) {}
    static final List<String> WISH_STATUS = List.of("Submitted", "Under review", "Planned", "Done", "Declined", "Withdrawn");
    public static final Resource<WishFields> WISHES = new Resource<>(
        new ResourceTable<>("wishes", "maintenance/wishes", "maintenance.wish", WishFields.class, "r.created_at DESC")
            .who("raisedBy").unitNo("unit", "unit_id").server("votes", Kind.TEXT_ARRAY).server("convertedTicketId", Kind.UUID).server("convertedTicketNo", Kind.TEXT),
        new ResourceRules<>() {
            @Override public boolean mayWrite(Caller c) { return c.category() != Caller.Category.Vendor && c.category() != Caller.Category.System; }
            @Override public WishFields validate(Caller c, WishFields f, WishFields old) {
                String title = Checks.required(f.title(), "Title");
                boolean reviewer = committee(c) || TicketRules.coordinator(c);
                if (old == null) {
                    if (c.isResident()) Checks.rule(f.unitId() == null || c.units().stream().anyMatch((u) -> u.value().equals(f.unitId())), "not-your-unit", "Add wishes for your own unit only");
                    UUID unit = f.unitId() != null ? f.unitId() : c.isResident() && c.units().size() == 1 ? c.units().iterator().next().value() : null;
                    return new WishFields(title, Checks.text(f.description(), "Description", 4000), Checks.text(f.category(), "Category", 60), Checks.text(f.location(), "Location", 200),
                        unit, "Submitted", null, null);
                }
                Checks.oneOf(f.status(), "Status", WISH_STATUS);
                if (!reviewer) {
                    // the person who raised it may edit the text while it is not yet picked up, and withdraw it
                    Checks.rule("Submitted".equals(old.status()), "under-review", "This wish is already being reviewed");
                    Checks.rule(java.util.Objects.equals(f.estimate(), old.estimate()) && java.util.Objects.equals(f.decisionNote(), old.decisionNote()), "reviewers-only", "Only the committee sets the estimate and the decision");
                    Checks.rule(f.status() == null || f.status().equals(old.status()) || "Withdrawn".equals(f.status()), "reviewers-only", "You can only withdraw your wish");
                }
                return new WishFields(title, Checks.text(f.description(), "Description", 4000), Checks.text(f.category(), "Category", 60), Checks.text(f.location(), "Location", 200),
                    old.unitId(), f.status() == null ? old.status() : f.status(), Checks.nonNegative(f.estimate(), "Estimate"), Checks.text(f.decisionNote(), "Decision", 2000));
            }
            @Override public boolean mayChange(Caller c, com.communityos.api.shared.resource.Item<WishFields> it) {
                return committee(c) || TicketRules.coordinator(c) || ResourceRules.mine(c, it, "raisedById");
            }
            @Override public boolean deletable(WishFields f) { return false; }   // withdrawn or declined, never deleted
            @Override public String label(WishFields f) { return f.title(); }
        });

    // ---- service notices (power cut, water supply ...) ------------------------------------------------------------------------------------------
    public record ServiceNoticeFields(String kind, String scope, List<String> blocks, String message, String expectedBy, String mode, String status, java.time.Instant startedAt, java.time.Instant resolvedAt) {}
    public static final Resource<ServiceNoticeFields> SERVICE_NOTICES = new Resource<>(
        new ResourceTable<>("serviceNotices", "maintenance/service-notices", "maintenance.service_notice", ServiceNoticeFields.class, "r.created_at DESC")
            .server("postedBy", "posted_by", Kind.TEXT, "(SELECT m.display_name FROM identity.membership m WHERE m.id = platform.current_actor())"),
        new ResourceRules<>() {
            @Override public boolean mayWrite(Caller c) { return committee(c) || TicketRules.coordinator(c); }
            @Override public ServiceNoticeFields validate(Caller c, ServiceNoticeFields f, ServiceNoticeFields old) {
                Checks.requiredOneOf(f.kind(), "Kind", List.of("Power cut", "Water supply", "Lift", "Internet / cable", "Gas supply", "Other"));
                String scope = f.scope() == null ? "Whole community" : Checks.oneOf(f.scope(), "Scope", List.of("Whole community", "Selected blocks"));
                Checks.rule(!"Selected blocks".equals(scope) || !Checks.list(f.blocks()).isEmpty(), "blocks-required", "Choose the blocks");
                String status = f.status() == null ? "Active" : Checks.oneOf(f.status(), "Status", List.of("Active", "Resolved"));
                return new ServiceNoticeFields(f.kind(), scope, Checks.list(f.blocks()), Checks.required(f.message(), "Message"), Checks.text(f.expectedBy(), "Expected by", 60),
                    Checks.oneOf(f.mode(), "Mode", List.of("Ask them to confirm", "Do not accept")), status, f.startedAt(), "Resolved".equals(status) && f.resolvedAt() == null ? java.time.Instant.now() : f.resolvedAt());
            }
            @Override public String label(ServiceNoticeFields f) { return f.kind(); }
        });

    // ---- work for events and bookings ---------------------------------------------------------------------------------------------------------
    public record EventWorkFields(String eventKind, UUID eventId, String eventName, LocalDate eventDate, String title, String details, String phase, LocalDate neededOn,
                                  LocalTime startTime, LocalTime endTime, String staffType, BigDecimal staffRequested, BigDecimal staffConfirmed, String ownerRole, String ownerName,
                                  String status, String notes) {}
    public static final Resource<EventWorkFields> EVENT_WORK = new Resource<>(
        new ResourceTable<>("eventWork", "maintenance/event-work", "maintenance.event_work", EventWorkFields.class, "r.needed_on NULLS LAST").filterBy("eventId"),
        new ResourceRules<>() {
            @Override public Spec<EventWorkFields> readScope(Caller c) { return ResourceRules.only(ResourceRules::staffOrCommittee, c); }
            @Override public boolean mayWrite(Caller c) { return committee(c) || TicketRules.coordinator(c) || c.has(Permission.MANAGE_CULTURAL); }
            @Override public EventWorkFields validate(Caller c, EventWorkFields f, EventWorkFields old) {
                Checks.oneOf(f.eventKind(), "Event kind", List.of("Cultural event", "Booking", "Other"));
                Checks.oneOf(f.phase(), "Phase", List.of("Before the event", "During the event", "After the event"));
                Checks.oneOf(f.status(), "Status", List.of("Not started", "In progress", "Blocked", "Done", "Cancelled"));
                Checks.rule(f.startTime() == null || f.endTime() == null || !f.endTime().isBefore(f.startTime()), "bad-times", "The end time is before the start time");
                Checks.nonNegative(f.staffRequested(), "Staff requested"); Checks.nonNegative(f.staffConfirmed(), "Staff confirmed");
                return new EventWorkFields(f.eventKind(), f.eventId(), f.eventName(), f.eventDate(), Checks.required(f.title(), "Title"), Checks.text(f.details(), "Details", 4000),
                    f.phase(), f.neededOn(), f.startTime(), f.endTime(), f.staffType(), f.staffRequested(), f.staffConfirmed(), f.ownerRole(), f.ownerName(),
                    f.status() == null ? "Not started" : f.status(), Checks.text(f.notes(), "Notes", 4000));
            }
            @Override public String label(EventWorkFields f) { return f.title(); }
        });

    // ---- trade availability (the duty board) ----------------------------------------------------------------------------------------------------
    public record TradeFields(String trade, BigDecimal available, BigDecimal assigned, BigDecimal offShift, BigDecimal slaPct) {}
    public static final Resource<TradeFields> TRADES = new Resource<>(
        new ResourceTable<>("tradeAvailability", "maintenance/trade-availability", "maintenance.trade_availability", TradeFields.class, "r.trade"),
        new ResourceRules<>() {
            @Override public Spec<TradeFields> readScope(Caller c) { return ResourceRules.only(ResourceRules::staffOrCommittee, c); }
            @Override public boolean mayWrite(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_FIELD_DUTIES) || TicketRules.coordinator(c); }
            @Override public TradeFields validate(Caller c, TradeFields f, TradeFields old) {
                Checks.nonNegative(f.available(), "Available"); Checks.nonNegative(f.assigned(), "Assigned"); Checks.nonNegative(f.offShift(), "Off shift");
                if (f.slaPct() != null && (f.slaPct().signum() < 0 || f.slaPct().compareTo(BigDecimal.valueOf(100)) > 0)) throw new DomainException.RuleViolated("bad-sla", "SLA % is between 0 and 100");
                return new TradeFields(Checks.required(f.trade(), "Trade"), f.available(), f.assigned(), f.offShift(), f.slaPct());
            }
            @Override public String label(TradeFields f) { return f.trade(); }
        });

    public static List<Resource<?>> all() { return List.of(TASK_TYPES, CATEGORIES, PHRASES, APPROVERS, WISHES, SERVICE_NOTICES, EVENT_WORK, TRADES); }
    static Map<String, Object> none() { return Map.of(); }
}
