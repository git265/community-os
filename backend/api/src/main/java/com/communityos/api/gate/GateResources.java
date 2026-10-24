package com.communityos.api.gate;

import com.communityos.api.gate.application.GatePolicy;
import com.communityos.api.gate.domain.Gate;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import java.math.BigDecimal;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * The gate registers (resource kit): the vetted registry, household staff, villa gate rules, pass templates, vehicles, crew work orders,
 * checkpoints and rounds, incidents and the gate settings. The desk itself (passes, visits, approvals, flags, scans) is GateService.
 */
public final class GateResources {
    private GateResources() {}
    static final SecureRandom RANDOM = new SecureRandom();

    /** A unit's own rows: residents read and write theirs; the gate team all. */
    static <F> Spec<F> ownUnit(Caller c, java.util.function.Function<F, UUID> unitOf) {
        if (GatePolicy.oversees(c)) return Spec.all();
        if (c.hasHome()) return Spec.in("r.unit_id", c.units().stream().map((u) -> u.value()).toList(), (f) -> unitOf.apply(f) != null && c.units().stream().anyMatch((u) -> u.value().equals(unitOf.apply(f))));
        return Spec.none();
    }
    static boolean mine(Caller c, UUID unit) { return unit != null && c.units().stream().anyMatch((u) -> u.value().equals(unit)); }
    static void days(List<String> d) { for (String x : Checks.list(d)) Checks.rule(Gate.DAYS.contains(x), "bad-day", "Days are Mon to Sun"); }
    static void times(LocalTime a, LocalTime b) { Checks.rule(a == null || b == null || !b.isBefore(a), "bad-times", "The end time is before the start time"); }

    // ---- the vetted registry -----------------------------------------------------------------------------------------------------------------
    public record PersonFields(String name, String personClass, String phone, String photo, String status, String vendor, String deliveryCompany, String idType, String idLast4,
                               boolean idFormatOk, String licenceNo, LocalDate licenceExpiry, String vehicleNo, boolean idChecked, boolean addressChecked, boolean policeVerified,
                               LocalDate policeExpiry, boolean referenceChecked, boolean faceEnrolled, String reviewNote, String statusReason, UUID invitedByUnitId,
                               String vendorService) {}   // vendorService: the vendor's category (service line) this worker is on
    public static final Resource<PersonFields> PEOPLE = new Resource<>(
        new ResourceTable<>("gatePeople", "gate/people", "gate.person", PersonFields.class, "r.name")
            .server("verifiedAt", Kind.TIMESTAMP).who("verifiedBy", "verified_by_id", false).unitNo("invitedByUnit", "invited_by_unit_id"),
        new ResourceRules<>() {
            @Override public Spec<PersonFields> readScope(Caller c) {
                if (GatePolicy.oversees(c)) return Spec.all();
                if (!c.hasHome()) return Spec.none();
                List<UUID> units = c.units().stream().map((u) -> u.value()).toList();
                Spec<PersonFields> invited = Spec.in("r.invited_by_unit_id", units, (f) -> mine(c, f.invitedByUnitId()));
                Spec<PersonFields> linked = new Spec<>("EXISTS (SELECT 1 FROM gate.household_link l WHERE l.community_id = r.community_id AND l.person_id = r.id AND l.unit_id = ANY (CAST(:s_link_units AS uuid[])))",
                    Map.of("s_link_units", "{" + String.join(",", units.stream().map(UUID::toString).toList()) + "}"), (f) -> false);
                return invited.or(linked);
            }
            @Override public boolean mayWrite(Caller c) { return GatePolicy.gateOrFm(c) || c.hasHome(); }
            @Override public boolean mayChange(Caller c, Item<PersonFields> it) {
                return GatePolicy.gateOrFm(c) || (mine(c, it.data().invitedByUnitId()) && !Gate.VETTED.contains(it.data().status()));
            }
            @Override public PersonFields validate(Caller c, PersonFields f, PersonFields old) {
                String name = Checks.required(f.name(), "Name");
                Checks.requiredOneOf(f.personClass(), "Kind of person", Gate.PERSON_CLASSES);
                Checks.rule(f.idLast4() == null || f.idLast4().matches("[0-9A-Za-z]{1,4}"), "bad-id", "Keep only the last 4 characters of the ID - the number itself is never stored");
                Checks.rule(f.photo() == null || f.photo().length() <= 400_000, "photo-too-big", "The photo is too large");
                if (GatePolicy.gateOrFm(c)) {
                    String status = f.status() == null ? "Invited" : Checks.oneOf(f.status(), "Status", Gate.PERSON_STATUS);
                    Checks.rule(!"Blocked".equals(status) && !"Suspended".equals(status) || (f.statusReason() != null && !f.statusReason().isBlank()), "reason-required", "Say why the person is blocked or suspended");
                    Checks.rule(!"Active".equals(status) || f.idChecked(), "not-vetted", "Tick the ID check before clearing a person for entry");
                    return new PersonFields(name, f.personClass(), Checks.phone(f.phone(), "Phone", true), f.photo(), status, f.vendor(), f.deliveryCompany(), f.idType(), up(f.idLast4()), f.idFormatOk(), f.licenceNo(),
                        f.licenceExpiry(), f.vehicleNo(), f.idChecked(), f.addressChecked(), f.policeVerified(), f.policeExpiry(), f.referenceChecked(), f.faceEnrolled(), f.reviewNote(),
                        f.statusReason(), f.invitedByUnitId(), Checks.text(f.vendorService(), "Vendor category", 80));
                }
                // a resident invites someone for their own household: no checks, no status beyond "invited"
                UUID unit = f.invitedByUnitId() != null ? f.invitedByUnitId() : c.units().size() == 1 ? c.units().iterator().next().value() : null;
                if (!mine(c, unit)) throw new AccessDenied("Invite people for your own unit");
                Checks.rule(f.status() == null || List.of("Invited", "Documents pending").contains(f.status()), "vetting", "Only the security team can vet or change the status");
                Checks.rule(!f.idChecked() && !f.addressChecked() && !f.policeVerified() && !f.referenceChecked() && !f.faceEnrolled() && f.reviewNote() == null && f.statusReason() == null,
                    "vetting", "Vetting checks are ticked by the security team");
                return new PersonFields(name, f.personClass(), Checks.phone(f.phone(), "Phone", true), f.photo(), f.status() == null ? "Invited" : f.status(), f.vendor(), f.deliveryCompany(), f.idType(), up(f.idLast4()),
                    false, f.licenceNo(), f.licenceExpiry(), f.vehicleNo(), false, false, false, null, false, false, null, null, unit, null);
            }
            @Override public boolean deletable(PersonFields f) { return !Gate.VETTED.contains(f.status()); }   // vetted people are blocked or suspended, not deleted
            @Override public String label(PersonFields f) { return f.name(); }
        });
    static String up(String s) { return s == null ? null : s.toUpperCase(); }

    // ---- household staff ---------------------------------------------------------------------------------------------------------------------
    public record LinkFields(UUID personId, String personName, UUID unitId, List<String> days, LocalTime fromTime, LocalTime toTime, String status) {}
    public static final Resource<LinkFields> LINKS = new Resource<>(
        new ResourceTable<>("gateLinks", "gate/household-links", "gate.household_link", LinkFields.class, "r.person_name").server("confirmedAt", Kind.TIMESTAMP).unitNo("unit", "unit_id").filterBy("personId"),
        new ResourceRules<>() {
            @Override public Spec<LinkFields> readScope(Caller c) { return ownUnit(c, LinkFields::unitId); }
            @Override public boolean mayWrite(Caller c) { return GatePolicy.gateOrFm(c) || c.hasHome(); }
            @Override public boolean mayChange(Caller c, Item<LinkFields> it) { return GatePolicy.gateOrFm(c) || mine(c, it.data().unitId()); }
            @Override public LinkFields validate(Caller c, LinkFields f, LinkFields old) {
                Checks.rule(f.personId() != null && f.unitId() != null, "required", "Choose the person and the unit");
                if (!GatePolicy.gateOrFm(c)) if (!(mine(c, f.unitId()) && (old == null || old.unitId().equals(f.unitId())))) throw new AccessDenied("A unit manages only its own household staff");
                days(f.days()); times(f.fromTime(), f.toTime());
                return new LinkFields(f.personId(), f.personName(), f.unitId(), Checks.list(f.days()), f.fromTime(), f.toTime(), f.status() == null ? "Active" : Checks.oneOf(f.status(), "Status", List.of("Active", "Ended")));
            }
            /** A unit links someone it invited, or a worker the gate team has cleared (Active) - never a blocked, suspended or unvetted stranger.
             *  The gate team and the FM link anyone. */
            @Override public void verify(Caller c, LinkFields f, LinkFields old, Facts db) {
                if (GatePolicy.gateOrFm(c) || (old != null && old.personId().equals(f.personId()))) return;
                List<String> units = c.units().stream().map((u) -> u.value().toString()).toList();
                if (!db.exists("SELECT 1 FROM gate.person p WHERE p.id = CAST(:p AS uuid) AND (p.invited_by_unit_id = ANY (CAST(:u AS uuid[])) OR p.status = 'Active')",
                        Map.of("p", f.personId().toString(), "u", com.communityos.api.shared.jdbc.Rows.pgArray(units))))
                    throw new AccessDenied("This person is not cleared by the gate team - invite them from your unit, or ask the gate team");
            }
            @Override public String label(LinkFields f) { return f.personName(); }
        });

    // ---- a unit's gate rule ------------------------------------------------------------------------------------------------------------------
    public record UnitRuleFields(UUID unitId, String deliveryMode, List<String> companies, Instant expectingUntil, boolean awayMode, String fallback, boolean tellGuestExit,
                                 boolean tellStaff, boolean tellDelivery) {}
    public static final Resource<UnitRuleFields> UNIT_RULES = new Resource<>(
        new ResourceTable<>("gateVillaRules", "gate/unit-rules", "gate.unit_rule", UnitRuleFields.class, "r.created_at").unitNo("unit", "unit_id"),
        new ResourceRules<>() {
            @Override public Spec<UnitRuleFields> readScope(Caller c) { return ownUnit(c, UnitRuleFields::unitId); }
            @Override public boolean mayWrite(Caller c) { return GatePolicy.gateStaff(c) || c.hasHome(); }
            @Override public boolean mayChange(Caller c, Item<UnitRuleFields> it) { return GatePolicy.gateStaff(c) || mine(c, it.data().unitId()); }
            @Override public UnitRuleFields validate(Caller c, UnitRuleFields f, UnitRuleFields old) {
                Checks.rule(f.unitId() != null, "unit-required", "Which unit?");
                if (!GatePolicy.gateStaff(c)) if (!(mine(c, f.unitId()) && (old == null || old.unitId().equals(f.unitId())))) throw new AccessDenied("A unit sets only its own gate rules");
                Checks.oneOf(f.deliveryMode(), "Delivery", List.of("Allow listed", "Allow all", "Ask me each time", "Leave at gate"));
                Checks.oneOf(f.fallback(), "When nobody answers", List.of("Community default", "Hold at gate", "Deny"));
                return f;
            }
            @Override public String label(UnitRuleFields f) { return "gate rule"; }
        });

    // ---- pass templates ----------------------------------------------------------------------------------------------------------------------
    public record TemplateFields(String name, UUID unitId, String passType, String visitorName, String phone, BigDecimal validityDays, LocalTime fromTime, LocalTime toTime, List<String> days,
                                 Integer guestCap, String vehicle, String goodsKind, Integer peopleCount, String material, boolean carryingOut) {}
    public static final Resource<TemplateFields> TEMPLATES = new Resource<>(
        new ResourceTable<>("gatePassTemplates", "gate/pass-templates", "gate.pass_template", TemplateFields.class, "r.name").unitNo("unit", "unit_id"),
        new ResourceRules<>() {
            @Override public Spec<TemplateFields> readScope(Caller c) { return ownUnit(c, TemplateFields::unitId); }
            @Override public boolean mayWrite(Caller c) { return GatePolicy.gateStaff(c) || c.hasHome(); }
            @Override public boolean mayChange(Caller c, Item<TemplateFields> it) { return GatePolicy.gateStaff(c) || mine(c, it.data().unitId()); }
            @Override public TemplateFields validate(Caller c, TemplateFields f, TemplateFields old) {
                if (!GatePolicy.gateStaff(c)) if (!(mine(c, f.unitId()) && (old == null || Objects.equals(old.unitId(), f.unitId())))) throw new AccessDenied("A unit keeps only its own pass templates");
                Checks.oneOf(f.passType(), "Pass type", Gate.PASS_TYPES); days(f.days()); times(f.fromTime(), f.toTime());
                return new TemplateFields(Checks.required(f.name(), "Name"), f.unitId(), f.passType(), f.visitorName(), f.phone(), Checks.nonNegative(f.validityDays(), "Validity"), f.fromTime(),
                    f.toTime(), Checks.list(f.days()), Checks.nonNegative(f.guestCap(), "Guest limit"), f.vehicle(), f.goodsKind(), Checks.nonNegative(f.peopleCount(), "People"), f.material(), f.carryingOut());
            }
            @Override public String label(TemplateFields f) { return f.name(); }
        });

    // ---- vehicles, work orders, checkpoints, rounds, incidents ---------------------------------------------------------------------------------
    public record VehicleFields(String plate, String fastag, UUID unitId, String owner, String vehicleClass, String status, boolean recurringGoods, BigDecimal usualPeople, String material) {}
    public static final Resource<VehicleFields> VEHICLES = new Resource<>(
        new ResourceTable<>("gateVehicles", "gate/vehicles", "gate.vehicle", VehicleFields.class, "r.plate").unitNo("unit", "unit_id"),
        new ResourceRules<>() {
            @Override public Spec<VehicleFields> readScope(Caller c) { return ownUnit(c, VehicleFields::unitId); }
            @Override public boolean mayWrite(Caller c) { return GatePolicy.gateStaff(c); }
            @Override public VehicleFields validate(Caller c, VehicleFields f, VehicleFields old) {
                String plate = Checks.required(f.plate(), "Plate").toUpperCase();
                Checks.rule(plate.replaceAll("\\s", "").matches("[A-Z0-9]{4,12}"), "bad-plate", "A number plate has 4 to 12 letters and digits");
                Checks.oneOf(f.vehicleClass(), "Class", List.of("Resident", "Tenant", "Staff", "Vendor", "Driver"));
                return new VehicleFields(plate, f.fastag(), f.unitId(), f.owner(), f.vehicleClass(), f.status() == null ? "Active" : Checks.oneOf(f.status(), "Status", List.of("Active", "Blocked", "Ended")),
                    f.recurringGoods(), Checks.nonNegative(f.usualPeople(), "Usual people"), f.material());
            }
            @Override public String label(VehicleFields f) { return f.plate(); }
        });
    public record WorkOrderFields(String title, String vendor, String area, List<String> days, LocalTime fromTime, LocalTime toTime, BigDecimal expectedHeadcount, List<UUID> rosterIds,
                                  String equipment, String ticketRef, String status) {}
    public static final Resource<WorkOrderFields> WORK_ORDERS = new Resource<>(
        new ResourceTable<>("gateWorkOrders", "gate/work-orders", "gate.work_order", WorkOrderFields.class, "r.created_at DESC"),
        new ResourceRules<>() {
            @Override public Spec<WorkOrderFields> readScope(Caller c) { return ResourceRules.only(GatePolicy::oversees, c); }
            @Override public boolean mayWrite(Caller c) { return GatePolicy.gateOrFm(c); }
            @Override public WorkOrderFields validate(Caller c, WorkOrderFields f, WorkOrderFields old) {
                days(f.days()); times(f.fromTime(), f.toTime());
                return new WorkOrderFields(Checks.required(f.title(), "Title"), f.vendor(), f.area(), Checks.list(f.days()), f.fromTime(), f.toTime(), Checks.nonNegative(f.expectedHeadcount(), "Headcount"),
                    Checks.list(f.rosterIds()), f.equipment(), f.ticketRef(), f.status() == null ? "Active" : Checks.oneOf(f.status(), "Status", List.of("Active", "Closed")));
            }
            @Override public boolean deletable(WorkOrderFields f) { return false; }
            @Override public String label(WorkOrderFields f) { return f.title(); }
        });
    /**
     * lat/lng: where the post is (pinned once by standing at it); radiusM: how far from it a scan still counts as at the post (default 40 m);
     * nfcTag: written as the tag's serial number when one is fitted, kept (and read back) only as its hash; blank removes the tag.
     */
    public record CheckpointFields(String name, String area, Integer order, boolean active, String code, BigDecimal lat, BigDecimal lng, Integer radiusM, String nfcTag) {}
    public static final Resource<CheckpointFields> CHECKPOINTS = new Resource<>(
        new ResourceTable<>("gateCheckpoints", "gate/checkpoints", "gate.checkpoint", CheckpointFields.class, "r.order_value NULLS LAST, r.name", Map.of("order", "order_value")),
        new ResourceRules<>() {
            @Override public Spec<CheckpointFields> readScope(Caller c) { return ResourceRules.only(GatePolicy::oversees, c); }
            @Override public boolean mayWrite(Caller c) { return GatePolicy.setsPatrols(c); }
            @Override public CheckpointFields validate(Caller c, CheckpointFields f, CheckpointFields old) {
                String code = f.code() == null || f.code().isBlank() ? (old != null && old.code() != null ? old.code() : newCode()) : f.code();
                Checks.rule(code.matches("[A-Za-z0-9]{6,40}"), "bad-code", "A checkpoint code has 6 to 40 letters and digits");
                Checks.rule((f.lat() == null) == (f.lng() == null), "bad-place", "A post's place needs both latitude and longitude");
                Checks.rule(f.lat() == null || (f.lat().abs().compareTo(BigDecimal.valueOf(90)) <= 0 && f.lng().abs().compareTo(BigDecimal.valueOf(180)) <= 0), "bad-place", "That is not a place on Earth");
                Checks.rule(f.radiusM() == null || (f.radiusM() >= 10 && f.radiusM() <= 500), "bad-radius", "A post's radius is 10 to 500 metres");
                java.util.function.Function<BigDecimal, BigDecimal> six = (x) -> x == null ? null : x.setScale(6, java.math.RoundingMode.HALF_UP);
                String tag = f.nfcTag() == null || f.nfcTag().isBlank() ? null : f.nfcTag().strip();
                if (tag != null && !(old != null && tag.equals(old.nfcTag()))) {        // a newly fitted tag: its serial, kept only as a hash
                    String serial = Gate.tagSerial(tag);
                    Checks.rule(serial != null, "bad-tag", "That is not an NFC tag's serial number");
                    tag = Gate.tagHash(c.community().value(), serial);
                }
                return new CheckpointFields(Checks.required(f.name(), "Name"), f.area(), f.order(), f.active(), code, six.apply(f.lat()), six.apply(f.lng()), f.radiusM(), tag);
            }
            @Override public String label(CheckpointFields f) { return f.name(); }
        });
    static String newCode() { String a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; StringBuilder b = new StringBuilder(); for (int i = 0; i < 10; i++) b.append(a.charAt(RANDOM.nextInt(a.length()))); return b.toString(); }
    public record RoundFields(String name, LocalTime time, BigDecimal windowMin, List<UUID> checkpointIds, List<String> days, boolean active) {}
    public static final Resource<RoundFields> ROUNDS = new Resource<>(
        new ResourceTable<>("gateRounds", "gate/rounds", "gate.round", RoundFields.class, "r.time NULLS LAST"),
        new ResourceRules<>() {
            @Override public Spec<RoundFields> readScope(Caller c) { return ResourceRules.only(GatePolicy::oversees, c); }
            @Override public boolean mayWrite(Caller c) { return GatePolicy.setsPatrols(c); }
            @Override public RoundFields validate(Caller c, RoundFields f, RoundFields old) {
                days(f.days());
                Checks.rule(f.time() != null, "time-required", "When does the round start?");
                Checks.rule(!Checks.list(f.checkpointIds()).isEmpty(), "checkpoints-required", "Choose the checkpoints of the round");
                BigDecimal w = f.windowMin() == null ? BigDecimal.valueOf(60) : f.windowMin();
                Checks.rule(w.intValue() >= 5 && w.intValue() <= 720, "bad-window", "A round takes 5 to 720 minutes");
                return new RoundFields(Checks.required(f.name(), "Name"), f.time(), w, f.checkpointIds(), Checks.list(f.days()), f.active());
            }
            @Override public String label(RoundFields f) { return f.name(); }
        });
    public record IncidentFields(String title, String gate, String description, Instant reportedAt, String assignedCommittee, String status) {}
    public static final Resource<IncidentFields> INCIDENTS = new Resource<>(
        new ResourceTable<>("incidents", "gate/incidents", "gate.incident", IncidentFields.class, "r.created_at DESC").who("reportedBy"),
        new ResourceRules<>() {
            @Override public Spec<IncidentFields> readScope(Caller c) { return ResourceRules.only(GatePolicy::oversees, c); }
            @Override public boolean mayWrite(Caller c) { return GatePolicy.gateStaff(c) || c.isCommittee(); }
            @Override public IncidentFields validate(Caller c, IncidentFields f, IncidentFields old) {
                String status = f.status() == null ? "Open" : Checks.oneOf(f.status(), "Status", List.of("Open", "EC review", "Resolved"));
                Checks.rule(!"Resolved".equals(status) || c.isCommittee() || c.isSuperAdmin(), "committee", "The committee closes an incident");
                Checks.rule(f.reportedAt() == null || !f.reportedAt().isAfter(Instant.now().plusSeconds(300)), "future", "An incident is not reported in the future");
                Checks.rule(old == null || f.reportedAt() == null || old.reportedAt() == null || f.reportedAt().equals(old.reportedAt()), "reported-at", "When it was reported is kept as recorded");
                return new IncidentFields(Checks.required(f.title(), "Title"), f.gate(), Checks.text(f.description(), "Description", 8000), f.reportedAt() == null ? Instant.now() : f.reportedAt(),
                    f.assignedCommittee(), status);
            }
            @Override public boolean deletable(IncidentFields f) { return false; }
            @Override public String label(IncidentFields f) { return f.title(); }
        });

    // ---- settings ------------------------------------------------------------------------------------------------------------------------------
    public record SettingsFields(Integer waitSeconds, String fallback, Integer graceSeconds, BigDecimal overstayGraceMinutes, BigDecimal autoCloseHours, BigDecimal guardSilenceMinutes,
                                 LocalTime quietFrom, LocalTime quietTo, String quietFallback, BigDecimal photoRetentionDays, boolean kioskOn, String goodsExtraPeople,
                                 BigDecimal patrolMinSeconds, String passMessage, Map<String, Integer> durations, List<String> approvedCompanies, Map<String, Object> events,
                                 String patrolNfc) {}
    public static final Resource<SettingsFields> SETTINGS = new Resource<>(
        new ResourceTable<>("gateSettings", "gate/settings", "gate.setting", SettingsFields.class, "r.created_at"),
        new ResourceRules<>() {
            @Override public Spec<SettingsFields> readScope(Caller c) { return ResourceRules.only(ResourceRules::staffOrCommittee, c); }
            @Override public boolean mayWrite(Caller c) { return c.isSuperAdmin() || c.isCommittee() || GatePolicy.fm(c); }
            @Override public SettingsFields validate(Caller c, SettingsFields f, SettingsFields old) {
                Checks.rule(old != null, "one-per-community", "The gate settings already exist - change them instead");
                Checks.rule(f.waitSeconds() == null || (f.waitSeconds() >= 10 && f.waitSeconds() <= 600), "bad-wait", "Wait 10 to 600 seconds for an answer");
                Checks.oneOf(f.fallback(), "When nobody answers", List.of("Hold at gate", "Deny")); Checks.oneOf(f.quietFallback(), "In quiet hours", List.of("Hold at gate", "Deny"));
                Checks.oneOf(f.goodsExtraPeople(), "Extra people in a goods vehicle", List.of("Block until the guard confirms", "Let in and flag"));
                Checks.rule(f.graceSeconds() == null || (f.graceSeconds() >= 0 && f.graceSeconds() <= 600), "bad-grace", "Grace is 0 to 600 seconds");
                Checks.between(f.overstayGraceMinutes(), "Overstay grace", 0, 1440); Checks.between(f.autoCloseHours(), "Auto-close", 0, 72);
                Checks.between(f.guardSilenceMinutes(), "Guard silence", 0, 1440); Checks.between(f.photoRetentionDays(), "Photo retention", 1, 3650);
                if (f.durations() != null) for (var e : f.durations().entrySet()) {
                    Checks.rule(Gate.KINDS.contains(e.getKey()), "bad-kind", "Unknown kind of visit: " + e.getKey());
                    Checks.rule(e.getValue() != null && e.getValue() >= 0 && e.getValue() <= 1440, "bad-minutes", "A visit lasts 0 to 1440 minutes");
                }
                if (f.patrolNfc() == null)   // not sent: as it was
                    return new SettingsFields(f.waitSeconds(), f.fallback(), f.graceSeconds(), f.overstayGraceMinutes(), f.autoCloseHours(), f.guardSilenceMinutes(), f.quietFrom(), f.quietTo(),
                        f.quietFallback(), f.photoRetentionDays(), f.kioskOn(), f.goodsExtraPeople(), f.patrolMinSeconds(), f.passMessage(), f.durations(), f.approvedCompanies(), f.events(),
                        old.patrolNfc() == null ? "Off" : old.patrolNfc());
                Checks.oneOf(f.patrolNfc(), "NFC tags on patrols", Gate.PATROL_NFC);
                return f;
            }
            @Override public boolean deletable(SettingsFields f) { return false; }
        });

    public static List<Resource<?>> all() { return List.of(PEOPLE, LINKS, UNIT_RULES, TEMPLATES, VEHICLES, WORK_ORDERS, CHECKPOINTS, ROUNDS, INCIDENTS, SETTINGS); }
}
