package com.communityos.api.billing;

import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Metered utilities (water, DG, gas ...): the utilities a community meters, the rate card of each, and each unit's monthly meter reading.
 * A reading is a draft until it is published (POST /billing/readings/publish, ReadingPublisher): the server prices and raises the unit's bill and
 * the reading points at it, and it is kept as it was billed. Status, bill and publish date are the server's: the app cannot set them here. Meter photos are files attached to the reading (owner type billing.reading).
 */
public final class UtilityResources {
    private UtilityResources() {}
    static boolean types(Caller c) { return ResourceRules.any(c, Permission.MANAGE_UTILITY_TYPES); }
    static boolean rates(Caller c) { return ResourceRules.any(c, Permission.MANAGE_UTILITY_BILLING, Permission.MANAGE_LEDGER); }
    /** Who records and publishes readings: the meter readers and the billing roles. */
    public static boolean readers(Caller c) { return ResourceRules.any(c, Permission.MANAGE_UTILITY_READINGS, Permission.MANAGE_UTILITY_BILLING, Permission.MANAGE_UTILITY_TYPES) || ResourceRules.staffOrCommittee(c); }
    public static boolean writers(Caller c) { return ResourceRules.any(c, Permission.MANAGE_UTILITY_READINGS, Permission.MANAGE_UTILITY_BILLING); }

    /** extraInputs: what else is written down with each reading of this utility (tank level, hours run ...): [{ key, label, type, unit, required }]. */
    public record UtilityTypeFields(String name, String icon, String label, String unitName, Boolean active, List<Map<String, Object>> extraInputs) {}
    public static final Resource<UtilityTypeFields> TYPES = new Resource<>(
        new ResourceTable<>("utilityTypes", "billing/utility-types", "billing.utility_type", UtilityTypeFields.class, "lower(r.name)"),
        new ResourceRules<>() {
            @Override public Spec<UtilityTypeFields> readScope(Caller c) { return c.category() == Caller.Category.Vendor ? Spec.none() : Spec.all(); }
            @Override public boolean mayWrite(Caller c) { return types(c); }
            @Override public UtilityTypeFields validate(Caller c, UtilityTypeFields f, UtilityTypeFields old) {
                String name = Checks.text(Checks.required(f.name(), "Utility name"), "Utility name", 40).strip();
                Checks.rule(old == null || old.name().equalsIgnoreCase(name), "rename", "A utility keeps its name (its bills and readings use it) - retire it and add a new one instead");
                return new UtilityTypeFields(name, Checks.text(f.icon(), "Icon", 8), Checks.text(f.label(), "Label", 60), Checks.text(f.unitName(), "Measured in", 20),
                    f.active() == null ? Boolean.TRUE : f.active(), extraInputs(f.extraInputs()));
            }
            @Override public boolean deletable(UtilityTypeFields f) { return false; }   // retire it (active = false): its readings and bills stay
            @Override public String label(UtilityTypeFields f) { return f.name(); }
        });

    /** The price of one utility: per unit, a fixed charge and tax on each bill. */
    public record RateCardFields(String type, BigDecimal ratePerUnit, BigDecimal fixedCharge, BigDecimal tax) {}
    public static final Resource<RateCardFields> RATE_CARDS = new Resource<>(
        new ResourceTable<>("billingTemplates", "billing/rate-cards", "billing.utility_rate_card", RateCardFields.class, "lower(r.type)"),
        new ResourceRules<>() {
            @Override public Spec<RateCardFields> readScope(Caller c) { return c.category() == Caller.Category.Vendor ? Spec.none() : Spec.all(); }
            @Override public boolean mayWrite(Caller c) { return rates(c); }
            @Override public RateCardFields validate(Caller c, RateCardFields f, RateCardFields old) {
                String type = Checks.text(Checks.required(f.type(), "Utility"), "Utility", 40).strip();
                Checks.rule(old == null || old.type().equalsIgnoreCase(type), "rate-card-type", "A rate card stays with its utility");
                Checks.rule(f.ratePerUnit() != null && f.ratePerUnit().signum() > 0, "bad-rate", "Enter the rate per unit");
                return new RateCardFields(type, f.ratePerUnit(), Checks.nonNegative(f.fixedCharge(), "Fixed charge"), Checks.nonNegative(f.tax(), "Tax"));
            }
            @Override public boolean deletable(RateCardFields f) { return false; }
            @Override public String label(RateCardFields f) { return f.type() + " rate card"; }
        });

    public record ReadingFields(UUID unitId, String utility, String month, LocalDate readingDate, BigDecimal previousReading, BigDecimal currentReading,
                                BigDecimal unitsConsumed, String notes, Map<String, Object> extras, String status, LocalDate publishedAt, UUID dueId) {}
    public static final Resource<ReadingFields> READINGS = new Resource<>(
        new ResourceTable<>("readings", "billing/readings", "billing.meter_reading", ReadingFields.class, "r.month DESC, r.utility")
            .computed("unit", Kind.TEXT, "(SELECT u.unit_no FROM property.unit u WHERE u.community_id = r.community_id AND u.id = r.unit_id)")
            .filterBy("utility").filterBy("month").filterBy("status"),
        new ResourceRules<>() {
            @Override public Spec<ReadingFields> readScope(Caller c) { return readers(c) ? Spec.all() : Spec.none(); }
            @Override public boolean mayWrite(Caller c) { return writers(c); }
            @Override public boolean mayChange(Caller c, Item<ReadingFields> it) { return !"Published".equals(it.data().status()); }   // billed: kept as it was billed
            @Override public ReadingFields validate(Caller c, ReadingFields f, ReadingFields old) {
                Checks.rule(f.unitId() != null, "unit-required", "Which villa / unit?");
                String utility = Checks.text(Checks.required(f.utility(), "Utility"), "Utility", 40).strip();
                String month = Checks.required(f.month(), "Month");
                Checks.rule(month.matches("\\d{4}-(0[1-9]|1[0-2])"), "bad-month", "A month is written YYYY-MM");
                Checks.rule(f.previousReading() != null && f.currentReading() != null, "reading-required", "Enter the previous and the current reading");
                Checks.rule(f.previousReading().signum() >= 0, "bad-reading", "A meter reading is 0 or more");
                Checks.rule(f.currentReading().compareTo(f.previousReading()) >= 0, "reading-lower", "The current reading cannot be lower than the previous reading");
                Checks.rule(f.readingDate() == null || !f.readingDate().isAfter(LocalDate.now().plusDays(1)), "future-reading", "A reading is not dated in the future");
                Checks.rule(f.extras() == null || f.extras().size() <= 12, "too-many-extras", "At most 12 extra values with a reading");
                // publishing is the server's command: whatever the request says, a reading keeps its status, bill and publish date here
                return new ReadingFields(f.unitId(), utility, month, f.readingDate(), f.previousReading(), f.currentReading(),
                    f.currentReading().subtract(f.previousReading()), Checks.text(f.notes(), "Notes", 500), f.extras(),
                    old == null ? "Draft" : old.status(), old == null ? null : old.publishedAt(), old == null ? null : old.dueId());
            }
            /** The utility's extra inputs marked required (tank level, hours run ...) come with the reading. */
            @Override public void verify(Caller c, ReadingFields f, ReadingFields old, Facts db) {
                if (db.exists("""
                        SELECT 1 FROM billing.utility_type t, jsonb_array_elements(coalesce(t.extra_inputs, '[]'::jsonb)) x
                        WHERE lower(t.name) = lower(:utility) AND coalesce(x->>'required', 'false') = 'true'
                          AND coalesce(btrim(CAST(:extras AS jsonb) ->> (x->>'key')), '') = ''""",
                        Map.of("utility", f.utility(), "extras", json(f.extras()))))
                    throw new com.communityos.api.shared.domain.DomainException.RuleViolated("required", "Fill in the " + f.utility() + " reading's required values");
            }
            @Override public boolean deletable(ReadingFields f) { return !"Published".equals(f.status()); }
            @Override public String label(ReadingFields f) { return f.utility() + " " + f.month(); }
        });

    static List<Map<String, Object>> extraInputs(List<Map<String, Object>> list) {
        if (list == null) return List.of();
        Checks.rule(list.size() <= 12, "too-many-inputs", "A utility has at most 12 extra inputs");
        for (Map<String, Object> m : list) Checks.rule(m != null && m.get("key") instanceof String k && !k.isBlank() && m.get("label") instanceof String l && !l.isBlank(), "bad-input", "Each extra input has a key and a label");
        return list;
    }
    static String json(Map<String, Object> m) {
        try { return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(m == null ? Map.of() : m); } catch (com.fasterxml.jackson.core.JsonProcessingException e) { return "{}"; }
    }
    public static List<Resource<?>> all() { return List.of(TYPES, RATE_CARDS, READINGS); }
}
