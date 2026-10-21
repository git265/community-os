package com.communityos.api.amenity;

import com.communityos.api.amenity.domain.AmenityType;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * The amenity registers (amenities, add-on items, settings). Who may change what follows the three amenity permissions: rates and money
 * (MANAGE_AMENITY_RATES), the rules text (MANAGE_AMENITY_RULES), everything else (MANAGE_AMENITIES); notification settings need
 * MANAGE_NOTIFICATIONS. Bookings are a workflow (BookingService).
 */
public final class AmenityResources {
    private AmenityResources() {}

    static boolean any(Caller c, Permission... p) { return c.isSuperAdmin() || c.hasAny(p); }
    /** The fields that changed between two records, by name (a new record: every field that is set). */
    static List<String> changed(Record a, Record b) {
        List<String> out = new ArrayList<>();
        for (var rc : b.getClass().getRecordComponents()) {
            try {
                Object nv = rc.getAccessor().invoke(b), ov = a == null ? null : rc.getAccessor().invoke(a);
                if (a == null ? nv != null && !Boolean.FALSE.equals(nv) && !(nv instanceof List<?> l && l.isEmpty()) : !Objects.equals(nv, ov)) out.add(rc.getName());
            } catch (ReflectiveOperationException e) { throw new IllegalStateException(e); }
        }
        return out;
    }

    // ---- amenities --------------------------------------------------------------------------------------------------------------------------
    public record TypeFields(String name, String icon, String facility, boolean active, String price, BigDecimal rate, String rateUnit, BigDecimal weekendRate, boolean gstApplicable,
                             BigDecimal gstRate, String gstMode, BigDecimal depositAmount, List<AmenityType.Tier> cancellationRules, Integer minNoticeHours, Integer maxAdvanceDays,
                             Integer capacity, String hours, String bookingMode, String rules, String reservation, List<String> overrideRoles, BigDecimal maxPerDay,
                             BigDecimal maxPerMonth, BigDecimal maxUpcoming, List<String> blackoutDates, List<String> allowedUnitTypes, List<String> slots) {}
    static final List<String> MONEY = List.of("price", "rate", "rateUnit", "weekendRate", "gstApplicable", "gstRate", "gstMode", "depositAmount", "cancellationRules", "minNoticeHours", "maxAdvanceDays");
    public static final Resource<TypeFields> TYPES = new Resource<>(
        new ResourceTable<>("amenityTypes", "amenities/types", "amenity.amenity_type", TypeFields.class, "r.name")
            // how much points at it: a type with bookings (past ones too) is closed, not deleted; the counts are shown before anyone tries
            .computed("bookings", com.communityos.api.shared.resource.ResourceTable.Kind.INT, "(SELECT count(*) FROM amenity.booking b WHERE b.community_id = r.community_id AND b.amenity_type_id = r.id)")
            .computed("upcomingBookings", com.communityos.api.shared.resource.ResourceTable.Kind.INT, "(SELECT count(*) FROM amenity.booking b WHERE b.community_id = r.community_id AND b.amenity_type_id = r.id AND b.status <> 'Cancelled' AND b.date >= CURRENT_DATE)")
            .computed("ownItems", com.communityos.api.shared.resource.ResourceTable.Kind.INT, "(SELECT count(*) FROM amenity.item i WHERE i.community_id = r.community_id AND i.amenity_type_id = r.id)"),
        new ResourceRules<>() {
            @Override public boolean mayWrite(Caller c) { return any(c, Permission.MANAGE_AMENITIES, Permission.MANAGE_AMENITY_RATES, Permission.MANAGE_AMENITY_RULES); }
            @Override public TypeFields validate(Caller c, TypeFields f, TypeFields old) {
                List<String> ch = changed(old, f);
                if (ch.stream().anyMatch(MONEY::contains) && !any(c, Permission.MANAGE_AMENITY_RATES)) throw new AccessDenied("Changing rates, GST, deposits or cancellation rules needs the \"Change amenity rates\" permission");
                if (ch.contains("rules") && !any(c, Permission.MANAGE_AMENITY_RULES)) throw new AccessDenied("Editing rules & regulations needs the \"Edit amenity rules\" permission");
                if (ch.stream().anyMatch((k) -> !MONEY.contains(k) && !k.equals("rules")) && !any(c, Permission.MANAGE_AMENITIES)) throw new AccessDenied("Requires amenities management access");
                String name = Checks.required(f.name(), "Name");
                Checks.rule(name.length() >= 2 && name.length() <= 60, "bad-name", "A name has 2 to 60 characters");
                Checks.oneOf(f.rateUnit(), "Rate unit", List.of("Per hour", "Per day / event", "Free"));
                Checks.oneOf(f.gstMode(), "GST mode", List.of("Exclusive", "Inclusive"));
                Checks.oneOf(f.bookingMode(), "Booking mode", List.of("Time slot", "Full day"));
                Checks.oneOf(f.reservation(), "Reservation", List.of("Reservation required", "Walk-in (no reservation)", com.communityos.api.amenity.domain.AmenityType.ITEMS_ONLY));
                for (BigDecimal b : new BigDecimal[] {f.rate(), f.weekendRate(), f.depositAmount(), f.maxPerDay(), f.maxPerMonth(), f.maxUpcoming()}) Checks.nonNegative(b, "An amount or limit");
                Checks.rule(f.gstRate() == null || (f.gstRate().signum() >= 0 && f.gstRate().compareTo(BigDecimal.valueOf(40)) <= 0), "bad-gst", "GST is between 0 and 40%");
                Checks.nonNegative(f.minNoticeHours(), "Minimum notice"); Checks.nonNegative(f.maxAdvanceDays(), "Advance days");
                int cap = f.capacity() == null ? 1 : f.capacity();
                Checks.rule(cap >= 1 && cap <= 1000, "bad-capacity", "Capacity is 1 to 1000 bookings at a time");
                for (AmenityType.Tier t : Checks.list(f.cancellationRules()))
                    Checks.rule(t.hoursBefore() != null && t.hoursBefore().signum() >= 0 && t.refundPct() != null && t.refundPct().signum() >= 0 && t.refundPct().compareTo(BigDecimal.valueOf(100)) <= 0,
                        "bad-tier", "A cancellation tier is hours before (0 or more) and a refund of 0 to 100%");
                for (String d : Checks.list(f.blackoutDates())) Checks.rule(d.matches("\\d{4}-\\d{2}-\\d{2}"), "bad-date", "Blocked dates are written YYYY-MM-DD");
                for (String s : Checks.list(f.slots())) Checks.rule(s.matches("\\d{1,2}:\\d{2}\\s*[-–]\\s*\\d{1,2}:\\d{2}"), "bad-slot", "A slot is written like 08:00–09:00");
                return new TypeFields(name, Checks.text(f.icon(), "Icon", 8), Checks.text(f.facility(), "Facility", 120), f.active(), Checks.text(f.price(), "Price", 120), f.rate(),
                    f.rateUnit(), f.weekendRate(), f.gstApplicable(), f.gstRate(), f.gstMode(), f.depositAmount(), f.cancellationRules() == null || f.cancellationRules().isEmpty() ? null : f.cancellationRules(),
                    f.minNoticeHours(), f.maxAdvanceDays(), cap, Checks.text(f.hours(), "Hours", 60), f.bookingMode(), Checks.text(f.rules(), "Rules", 20000), f.reservation(),
                    Checks.list(f.overrideRoles()), f.maxPerDay(), f.maxPerMonth(), f.maxUpcoming(), Checks.list(f.blackoutDates()), Checks.list(f.allowedUnitTypes()), Checks.list(f.slots()));
            }
            // one never booked can go (a mistake, a duplicate); one with bookings is closed (Open for booking off) so its history stays
            @Override public String whyNotDeletable(com.communityos.api.shared.resource.Item<TypeFields> it) {
                int booked = count(it.server("bookings")), items = count(it.server("ownItems"));
                if (booked > 0) return it.data().name() + " has " + booked + " booking" + (booked == 1 ? "" : "s") + " (past ones count too), so it is kept for their history. Switch off \"Open for booking\" to stop new bookings.";
                if (items > 0) return items + " add-on item" + (items == 1 ? " is" : "s are") + " offered only with " + it.data().name() + ". Offer them with every amenity, or delete them, first.";
                return null;
            }
            @Override public String label(TypeFields f) { return f.name(); }
        });

    // ---- add-on items ---------------------------------------------------------------------------------------------------------------------------
    public record ItemFields(String name, UUID amenityTypeId, BigDecimal stock, BigDecimal price, String perLabel, BigDecimal maxPerBooking, boolean active) {}
    public static final Resource<ItemFields> ITEMS = new Resource<>(
        new ResourceTable<>("amenityItems", "amenities/items", "amenity.item", ItemFields.class, "r.name")
            .computed("amenity", ResourceTable.Kind.TEXT, "(SELECT t.name FROM amenity.amenity_type t WHERE t.id = r.amenity_type_id)"),
        new ResourceRules<>() {
            @Override public boolean mayWrite(Caller c) { return any(c, Permission.MANAGE_AMENITIES, Permission.MANAGE_AMENITY_RATES); }
            @Override public ItemFields validate(Caller c, ItemFields f, ItemFields old) {
                Checks.nonNegative(f.stock(), "Stock"); Checks.nonNegative(f.price(), "Price"); Checks.nonNegative(f.maxPerBooking(), "Most per booking");
                return new ItemFields(Checks.required(f.name(), "Name"), f.amenityTypeId(), f.stock(), f.price(), Checks.text(f.perLabel(), "Per", 40), f.maxPerBooking(), f.active());
            }
            @Override public String label(ItemFields f) { return f.name(); }
        });

    // ---- settings (one row) ---------------------------------------------------------------------------------------------------------------------
    public record SettingsFields(String gstin, BigDecimal defaultGstRate, String receiptAccount, String refundMode, BigDecimal paymentDueHours, boolean notifyOwner, boolean notifyAdmin,
                                 String adminRecipients, String reportRecipients, boolean dailyReport, String dailyReportTime, String summaryReport, boolean reminderOn) {}
    static final List<String> NOTIFY = List.of("adminRecipients", "reportRecipients", "dailyReport", "dailyReportTime", "summaryReport", "reminderOn", "notifyOwner", "notifyAdmin");
    public static final Resource<SettingsFields> SETTINGS = new Resource<>(
        new ResourceTable<>("amenitySettings", "amenities/settings", "amenity.setting", SettingsFields.class, "r.created_at"),
        new ResourceRules<>() {
            @Override public Spec<SettingsFields> readScope(Caller c) { return ResourceRules.only(ResourceRules::staffOrCommittee, c); }
            @Override public boolean mayWrite(Caller c) { return any(c, Permission.MANAGE_AMENITIES, Permission.MANAGE_AMENITY_RATES, Permission.MANAGE_NOTIFICATIONS); }
            @Override public SettingsFields validate(Caller c, SettingsFields f, SettingsFields old) {
                Checks.rule(old != null, "one-per-community", "The amenity settings already exist - change them instead");
                List<String> ch = changed(old, f);
                if (ch.stream().anyMatch(NOTIFY::contains) && !any(c, Permission.MANAGE_NOTIFICATIONS)) throw new AccessDenied("Changing who is notified and when reports go out needs the \"Edit notification templates\" permission");
                if (ch.stream().anyMatch((k) -> !NOTIFY.contains(k)) && !any(c, Permission.MANAGE_AMENITY_RATES, Permission.MANAGE_AMENITIES)) throw new AccessDenied("Changing GST / payment / refund settings needs the \"Change amenity rates\" permission");
                Checks.oneOf(f.refundMode(), "Refund mode", List.of("Credit to unit account", "Original payment mode (manual)"));
                Checks.oneOf(f.summaryReport(), "Summary report", List.of("Off", "Weekly", "Monthly"));
                Checks.rule(f.defaultGstRate() == null || (f.defaultGstRate().signum() >= 0 && f.defaultGstRate().compareTo(BigDecimal.valueOf(40)) <= 0), "bad-gst", "GST is between 0 and 40%");
                Checks.nonNegative(f.paymentDueHours(), "Hours to pay");
                return f;
            }
            @Override public boolean deletable(SettingsFields f) { return false; }
        });

    static int count(Object v) { return v instanceof Number n ? n.intValue() : 0; }
    public static List<Resource<?>> all() { return List.of(TYPES, ITEMS, SETTINGS); }
}
