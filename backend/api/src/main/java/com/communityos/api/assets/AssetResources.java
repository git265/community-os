package com.communityos.api.assets;

import com.communityos.api.assets.application.AssetPolicy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.Caller;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The asset registers (resource kit). Stock quantities move only through AssetService (movements) and an asset's condition through its
 * condition log, so those columns are the server's here. Worked-out values (litres x rate, meter differences, cost per unit, the next audit)
 * are computed on the server, whatever the screen sent.
 */
public final class AssetResources {
    private AssetResources() {}
    public static final List<String> CONDITIONS = List.of("Working", "Needs attention", "Under repair", "Out of service", "Standby", "Retired");
    static final List<String> UOMS = List.of("Nos", "Kg", "Litres", "Metres", "Boxes", "Sets");
    static <F extends Record> Spec<F> readers(Caller c) { return AssetPolicy.reader(c) ? Spec.all() : Spec.none(); }
    static BigDecimal diff(BigDecimal open, BigDecimal close, String label) {
        if (open == null || close == null) return null;
        Checks.rule(close.compareTo(open) >= 0, "meter-backwards", label + ": the closing reading is below the opening one");
        return close.subtract(open);
    }
    static BigDecimal nn(BigDecimal v, String label) { return Checks.nonNegative(v, label); }

    // ---- equipment ---------------------------------------------------------------------------------------------------------------------------------
    public record EquipmentFields(String name, String area, String type, String repairCategory, List<String> alsoCategories, String location, Integer quantity, Map<String, Object> specs,
                                  BigDecimal backupHours, LocalDate batteryChanged, String make, String model, String serialNo, String rating, LocalDate installDate, LocalDate warrantyUntil,
                                  String warrantyProvider, String warrantyTerms, String amcVendor, LocalDate lastService, LocalDate nextService, String status, Integer faulty,
                                  List<String> serves, String closeValve, LocalDate lastInspected, String shape, String breaks, UUID planId, String spares, String history) {}
    public static final Resource<EquipmentFields> EQUIPMENT = new Resource<>(
        new ResourceTable<>("equipment", "assets/equipment", "assets.equipment", EquipmentFields.class, "r.area NULLS LAST, lower(r.name)")
            .computed("openTasks", Kind.INT, "(SELECT count(*) FROM assets.condition_log l WHERE l.community_id = r.community_id AND l.asset_id = r.id AND l.condition <> 'Working')"),
        new ResourceRules<>() {
            @Override public Spec<EquipmentFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.writer(c); }
            @Override public EquipmentFields validate(Caller c, EquipmentFields f, EquipmentFields old) {
                String name = Checks.text(Checks.required(f.name(), "Name"), "Name", 200);
                Checks.rule(old == null || old.name().equalsIgnoreCase(name) || AssetPolicy.renames(c), "name-fixed",
                    "An asset's name is fixed once saved (tasks and the map quote it). Only an admin or an EC member can rename it");
                Integer qty = Checks.nonNegative(f.quantity(), "Quantity"), faulty = Checks.nonNegative(f.faulty(), "Faulty");
                Checks.rule(faulty == null || qty == null || faulty <= qty, "too-many-faulty", "More faulty than there are");
                Checks.rule(f.nextService() == null || f.lastService() == null || !f.nextService().isBefore(f.lastService()), "bad-dates", "The next service is before the last one");
                return new EquipmentFields(name, f.area(), f.type(), f.repairCategory(), Checks.list(f.alsoCategories()), Checks.text(f.location(), "Location", 200), qty, f.specs(),
                    nn(f.backupHours(), "Backup hours"), f.batteryChanged(), f.make(), f.model(), f.serialNo(), f.rating(), f.installDate(), f.warrantyUntil(), f.warrantyProvider(),
                    Checks.text(f.warrantyTerms(), "Warranty terms", 4000), f.amcVendor(), f.lastService(), f.nextService(), f.status() == null ? "Working" : Checks.oneOf(f.status(), "Condition", CONDITIONS),
                    faulty, Checks.list(f.serves()), f.closeValve(), f.lastInspected(), f.shape(), f.breaks(), f.planId(), Checks.text(f.spares(), "Spares", 20_000), Checks.text(f.history(), "History", 50_000));
            }
            @Override public String label(EquipmentFields f) { return f.name(); }
        });

    // ---- stock -------------------------------------------------------------------------------------------------------------------------------------
    public static final String STOCK_STATUS = "CASE WHEN r.quantity <= 0 THEN 'Out of stock' WHEN r.min_stock IS NOT NULL AND r.quantity <= r.min_stock THEN 'Low' ELSE 'In stock' END";
    public record InventoryFields(String item, String category, String location, String uom, BigDecimal minStock, String vendor, LocalDate warrantyUntil, String warrantyProvider,
                                  String warrantyTerms, String notes) {}
    public static final Resource<InventoryFields> INVENTORY = new Resource<>(
        new ResourceTable<>("inventory", "assets/inventory", "assets.inventory_item", InventoryFields.class, "r.category NULLS LAST, lower(r.item)")
            .server("quantity", Kind.NUMERIC).server("lastRestocked", Kind.DATE).computed("stockStatus", Kind.TEXT, STOCK_STATUS),
        new ResourceRules<>() {
            @Override public Spec<InventoryFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.coordinator(c); }
            @Override public InventoryFields validate(Caller c, InventoryFields f, InventoryFields old) {
                return new InventoryFields(Checks.text(Checks.required(f.item(), "Item"), "Item", 200), Checks.text(f.category(), "Category", 80), Checks.text(f.location(), "Location", 120),
                    f.uom() == null ? "Nos" : Checks.oneOf(f.uom(), "Unit", UOMS), nn(f.minStock(), "Minimum stock"), f.vendor(), f.warrantyUntil(), f.warrantyProvider(),
                    Checks.text(f.warrantyTerms(), "Warranty terms", 4000), Checks.text(f.notes(), "Notes", 20_000));
            }
            @Override public String label(InventoryFields f) { return f.item(); }
        });
    public record InventoryRuleFields(String name, String matchOn, List<String> keywords, String category, String uom, String location, BigDecimal minStock, BigDecimal priority, Boolean active) {}
    public static final Resource<InventoryRuleFields> INVENTORY_RULES = new Resource<>(
        new ResourceTable<>("inventoryRules", "assets/inventory-rules", "assets.inventory_rule", InventoryRuleFields.class, "r.priority NULLS LAST, r.name"),
        new ResourceRules<>() {
            @Override public Spec<InventoryRuleFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.coordinator(c); }
            @Override public InventoryRuleFields validate(Caller c, InventoryRuleFields f, InventoryRuleFields old) {
                return new InventoryRuleFields(Checks.required(f.name(), "Name"), Checks.oneOf(f.matchOn(), "Match on", List.of("Item description", "Category column in the file")), Checks.list(f.keywords()),
                    f.category(), Checks.oneOf(f.uom(), "Unit", UOMS), f.location(), nn(f.minStock(), "Minimum stock"), f.priority(), f.active() == null ? Boolean.TRUE : f.active());
            }
        });

    // ---- readings and bills ------------------------------------------------------------------------------------------------------------------------
    public record PlantLogFields(LocalDate date, BigDecimal bhOpen, BigDecimal bhClose, BigDecimal bhKl, BigDecimal wtpOpen, BigDecimal wtpClose, BigDecimal wtpKl, BigDecimal stpOpen,
                                 BigDecimal stpClose, BigDecimal stpKl, BigDecimal saltStock, BigDecimal saltUsed, BigDecimal chlorineStock, BigDecimal chlorineUsed, String remarks) {}
    public static final Resource<PlantLogFields> PLANT_LOGS = new Resource<>(
        new ResourceTable<>("plantLogs", "assets/plant-logs", "assets.plant_log", PlantLogFields.class, "r.date DESC"),
        new ResourceRules<>() {
            @Override public Spec<PlantLogFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.writer(c); }
            @Override public PlantLogFields validate(Caller c, PlantLogFields f, PlantLogFields old) {
                Checks.rule(f.date() != null, "date-required", "Which day?");
                BigDecimal bh = diff(f.bhOpen(), f.bhClose(), "Bhagiratha"), wtp = diff(f.wtpOpen(), f.wtpClose(), "WTP"), stp = diff(f.stpOpen(), f.stpClose(), "STP");
                return new PlantLogFields(f.date(), f.bhOpen(), f.bhClose(), bh == null ? nn(f.bhKl(), "KL") : bh, f.wtpOpen(), f.wtpClose(), wtp == null ? nn(f.wtpKl(), "KL") : wtp,
                    f.stpOpen(), f.stpClose(), stp == null ? nn(f.stpKl(), "KL") : stp, nn(f.saltStock(), "Salt stock"), nn(f.saltUsed(), "Salt used"), nn(f.chlorineStock(), "Chlorine stock"),
                    nn(f.chlorineUsed(), "Chlorine used"), Checks.text(f.remarks(), "Remarks", 2000));
            }
        });
    public record DgFuelFields(LocalDate date, String generator, BigDecimal hoursReading, BigDecimal kwhReading, BigDecimal litres, BigDecimal rate, BigDecimal amount, Boolean partial,
                               String supplier, String billNo, String taskRef, String notes) {}
    public static final Resource<DgFuelFields> DG_FUEL = new Resource<>(
        new ResourceTable<>("dgFuelLogs", "assets/dg-fuel", "assets.dg_fuel_log", DgFuelFields.class, "r.date DESC"),
        new ResourceRules<>() {
            @Override public Spec<DgFuelFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.writer(c); }
            @Override public DgFuelFields validate(Caller c, DgFuelFields f, DgFuelFields old) {
                Checks.rule(f.date() != null, "date-required", "Which day?");
                Checks.rule(f.litres() != null && f.litres().signum() > 0, "litres-required", "How many litres?");
                BigDecimal amount = f.rate() == null ? nn(f.amount(), "Amount") : nn(f.rate(), "Rate").multiply(f.litres()).setScale(2, RoundingMode.HALF_UP);
                return new DgFuelFields(f.date(), Checks.text(f.generator(), "Generator", 80), nn(f.hoursReading(), "Hours"), nn(f.kwhReading(), "kWh"), f.litres(), f.rate(), amount,
                    Boolean.TRUE.equals(f.partial()), f.supplier(), Checks.text(f.billNo(), "Bill no.", 60), f.taskRef(), Checks.text(f.notes(), "Notes", 4000));
            }
        });
    public record ElectricityBillFields(String service, String serviceNo, String period, LocalDate billDate, LocalDate dueDate, BigDecimal units, BigDecimal exportUnits, BigDecimal creditUnits,
                                        BigDecimal creditAmount, BigDecimal mdKva, BigDecimal loadKw, BigDecimal fixedCharges, BigDecimal energyCharges, BigDecimal otherCharges, BigDecimal amount,
                                        String status, LocalDate paidOn, String paidFrom, String paymentRef, BigDecimal costPerUnit, String notes) {}
    public static final Resource<ElectricityBillFields> ELECTRICITY_BILLS = new Resource<>(
        new ResourceTable<>("electricityBills", "assets/electricity-bills", "assets.electricity_bill", ElectricityBillFields.class, "r.bill_date DESC NULLS LAST"),
        new ResourceRules<>() {
            @Override public Spec<ElectricityBillFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.writer(c); }
            @Override public ElectricityBillFields validate(Caller c, ElectricityBillFields f, ElectricityBillFields old) {
                String status = f.status() == null ? "Unpaid" : Checks.oneOf(f.status(), "Status", List.of("Unpaid", "Paid"));
                Checks.rule(!"Paid".equals(status) || f.paidOn() != null, "paid-on-required", "When was it paid?");
                Checks.rule(f.dueDate() == null || f.billDate() == null || !f.dueDate().isBefore(f.billDate()), "bad-dates", "The due date is before the bill date");
                for (BigDecimal b : new BigDecimal[] {f.units(), f.exportUnits(), f.creditUnits(), f.creditAmount(), f.amount(), f.fixedCharges(), f.energyCharges(), f.otherCharges()}) nn(b, "Amounts and units");
                BigDecimal cpu = f.amount() != null && f.units() != null && f.units().signum() > 0 ? f.amount().divide(f.units(), 2, RoundingMode.HALF_UP) : null;
                return new ElectricityBillFields(f.service(), Checks.text(f.serviceNo(), "Service no.", 60), Checks.text(f.period(), "Period", 40), f.billDate(), f.dueDate(), f.units(), f.exportUnits(),
                    f.creditUnits(), f.creditAmount(), f.mdKva(), f.loadKw(), f.fixedCharges(), f.energyCharges(), f.otherCharges(), f.amount(), status, "Paid".equals(status) ? f.paidOn() : null,
                    "Paid".equals(status) ? f.paidFrom() : null, "Paid".equals(status) ? f.paymentRef() : null, cpu, Checks.text(f.notes(), "Notes", 4000));
            }
        });
    public record UnitElectricityFields(UUID unitId, String month, BigDecimal units, BigDecimal exportUnits, BigDecimal creditUnits, BigDecimal amount, BigDecimal creditAmount, BigDecimal mdKw,
                                        BigDecimal sanctionedKw, String notes) {}
    public static final Resource<UnitElectricityFields> UNIT_ELECTRICITY = new Resource<>(
        new ResourceTable<>("villaElectricity", "assets/unit-electricity", "assets.unit_electricity", UnitElectricityFields.class, "r.month DESC").unitNo("unit", "unit_id").filterBy("unitId"),
        new ResourceRules<>() {
            @Override public Spec<UnitElectricityFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.writer(c); }
            @Override public UnitElectricityFields validate(Caller c, UnitElectricityFields f, UnitElectricityFields old) {
                Checks.rule(f.unitId() != null, "unit-required", "Which unit?");
                Checks.rule(f.month() != null && f.month().matches("[0-9]{4}-(0[1-9]|1[0-2])"), "bad-month", "The month is like 2026-10");
                for (BigDecimal b : new BigDecimal[] {f.units(), f.amount(), f.mdKw(), f.sanctionedKw(), f.exportUnits(), f.creditUnits(), f.creditAmount()}) nn(b, "Units and amounts");
                return new UnitElectricityFields(f.unitId(), f.month(), f.units(), f.exportUnits(), f.creditUnits(), f.amount(), f.creditAmount(), f.mdKw(), f.sanctionedKw(), Checks.text(f.notes(), "Notes", 500));
            }
        });
    public record ImportRuleFields(String name, String sheet, BigDecimal headerRow, String unitCol, String unitPrefix, String monthCol, String unitsCol, String exportCol, String creditUnitsCol,
                                   String amountCol, String creditAmountCol, String mdCol, String sanctionedCol) {}
    public static final Resource<ImportRuleFields> IMPORT_RULES = new Resource<>(
        new ResourceTable<>("villaImportRules", "assets/unit-import-rules", "assets.unit_meter_import_rule", ImportRuleFields.class, "r.name"),
        new ResourceRules<>() {
            @Override public Spec<ImportRuleFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.admin(c); }
            @Override public ImportRuleFields validate(Caller c, ImportRuleFields f, ImportRuleFields old) { Checks.required(f.name(), "Name"); return f; }
        });

    // ---- audits and custom logs --------------------------------------------------------------------------------------------------------------------
    public record AuditFields(String area, LocalDate auditDate, String auditor, UUID auditorVendorId, String result, BigDecimal score, String parameters, String findings, String actions,
                              BigDecimal frequencyMonths, LocalDate nextDue, String taskRef, String visibility) {}
    public static final Resource<AuditFields> AUDITS = new Resource<>(
        new ResourceTable<>("audits", "assets/audits", "assets.facility_audit", AuditFields.class, "r.audit_date DESC NULLS LAST"),
        new ResourceRules<>() {
            /** Residents read what the committee published. */
            @Override public Spec<AuditFields> readScope(Caller c) {
                if (AssetPolicy.reader(c)) return Spec.all();
                return AssetPolicy.member(c) ? Spec.eq("r.visibility", "Published", (f) -> "Published".equals(f.visibility())) : Spec.none();
            }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.coordinator(c); }
            @Override public AuditFields validate(Caller c, AuditFields f, AuditFields old) {
                BigDecimal score = f.score();
                Checks.rule(score == null || (score.signum() >= 0 && score.compareTo(BigDecimal.valueOf(100)) <= 0), "bad-score", "A score is from 0 to 100");
                BigDecimal freq = f.frequencyMonths();
                Checks.rule(freq == null || (freq.signum() >= 0 && freq.compareTo(BigDecimal.valueOf(120)) <= 0), "bad-frequency", "Every 0 to 120 months");
                LocalDate next = f.nextDue();
                if (f.auditDate() != null && freq != null && freq.signum() > 0) next = f.auditDate().plusMonths(freq.intValue());   // worked out, not typed
                Checks.rule(next == null || f.auditDate() == null || !next.isBefore(f.auditDate()), "bad-dates", "The next audit is before this one");
                return new AuditFields(Checks.required(f.area(), "Area"), f.auditDate(), Checks.text(f.auditor(), "Auditor", 200), f.auditorVendorId(),
                    f.result() == null ? "Pending" : Checks.oneOf(f.result(), "Result", List.of("Pass", "Pass with observations", "Fail", "Pending")), score, f.parameters(),
                    Checks.text(f.findings(), "Findings", 20_000), Checks.text(f.actions(), "Actions", 20_000), freq, next, f.taskRef(),
                    f.visibility() == null ? "Internal" : Checks.oneOf(f.visibility(), "Visibility", List.of("Internal", "Published")));
            }
            @Override public String label(AuditFields f) { return f.area() + " audit"; }
        });
    public record LogTypeFields(String name, String icon, String description, String frequency, String fields, Boolean active) {}
    public static final Resource<LogTypeFields> LOG_TYPES = new Resource<>(
        new ResourceTable<>("logTypes", "assets/log-types", "assets.log_type", LogTypeFields.class, "lower(r.name)"),
        new ResourceRules<>() {
            @Override public Spec<LogTypeFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.admin(c); }
            @Override public LogTypeFields validate(Caller c, LogTypeFields f, LogTypeFields old) {
                return new LogTypeFields(Checks.text(Checks.required(f.name(), "Name"), "Name", 120), f.icon(), Checks.text(f.description(), "Description", 500),
                    Checks.oneOf(f.frequency(), "Frequency", List.of("Daily", "Weekly", "Monthly", "As needed")), Checks.text(f.fields(), "Fields", 20_000), f.active() == null ? Boolean.TRUE : f.active());
            }
            @Override public String label(LogTypeFields f) { return f.name(); }
        });
    public record LogEntryFields(UUID logId, LocalDate date, String values, String note) {}
    public static final Resource<LogEntryFields> LOG_ENTRIES = new Resource<>(
        new ResourceTable<>("logEntries", "assets/log-entries", "assets.log_entry", LogEntryFields.class, "r.date DESC").who("recordedBy", "created_by", false).filterBy("logId"),
        new ResourceRules<>() {
            @Override public Spec<LogEntryFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.writer(c); }
            @Override public LogEntryFields validate(Caller c, LogEntryFields f, LogEntryFields old) {
                Checks.rule(f.logId() != null, "log-required", "Which log?"); Checks.rule(f.date() != null, "date-required", "Which day?");
                return new LogEntryFields(f.logId(), f.date(), Checks.text(f.values(), "Values", 20_000), Checks.text(f.note(), "Note", 4000));
            }
        });

    // ---- the site map ------------------------------------------------------------------------------------------------------------------------------
    public record PlanFields(String name, String imageUrl, BigDecimal width, BigDecimal height, BigDecimal metersPerPx, String notes, Integer order, String boundary, String geoRef, String tileUrl) {}
    public static final Resource<PlanFields> PLANS = new Resource<>(
        new ResourceTable<>("infraPlans", "assets/site-plans", "assets.site_plan", PlanFields.class, "r.order_value NULLS LAST, r.name", Map.of("order", "order_value")),
        new ResourceRules<>() {
            @Override public Spec<PlanFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.coordinator(c); }
            @Override public PlanFields validate(Caller c, PlanFields f, PlanFields old) {
                Checks.rule(f.imageUrl() == null || f.imageUrl().length() <= 12_000_000, "image-too-big", "The plan image is too large");
                return new PlanFields(Checks.required(f.name(), "Name"), f.imageUrl(), nn(f.width(), "Width"), nn(f.height(), "Height"), nn(f.metersPerPx(), "Scale"), f.notes(), f.order(), f.boundary(), f.geoRef(), f.tileUrl());
            }
            @Override public String label(PlanFields f) { return f.name(); }
        });
    public record LayerFields(String type, String geometry, String icon, BigDecimal spacing, String specs, Boolean hidden) {}
    public static final Resource<LayerFields> LAYERS = new Resource<>(
        new ResourceTable<>("infraLayers", "assets/map-layers", "assets.map_layer", LayerFields.class, "r.type"),
        new ResourceRules<>() {
            @Override public Spec<LayerFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.coordinator(c); }
            @Override public LayerFields validate(Caller c, LayerFields f, LayerFields old) {
                return new LayerFields(Checks.required(f.type(), "Type"), Checks.oneOf(f.geometry(), "Geometry", List.of("Point", "Line", "Zone")), f.icon(), nn(f.spacing(), "Spacing"), f.specs(), Boolean.TRUE.equals(f.hidden()));
            }
        });
    /** The map's history: every change, with what it was before; written once (who and when are the server's). */
    public record MapVersionFields(String kind, UUID recordId, String name, String action, String summary, String before, String after) {}
    public static final Resource<MapVersionFields> MAP_VERSIONS = new Resource<>(
        new ResourceTable<>("mapVersions", "assets/map-history", "assets.map_version", MapVersionFields.class, "r.created_at DESC").who("by").computed("at", Kind.TIMESTAMP, "r.created_at"),
        new ResourceRules<>() {
            @Override public Spec<MapVersionFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return AssetPolicy.coordinator(c); }
            @Override public boolean mayChange(Caller c, Item<MapVersionFields> it) { return false; }
            @Override public boolean deletable(MapVersionFields f) { return false; }
            @Override public MapVersionFields validate(Caller c, MapVersionFields f, MapVersionFields old) {
                return new MapVersionFields(Checks.required(f.kind(), "Kind"), f.recordId(), f.name(), Checks.required(f.action(), "Action"), Checks.text(f.summary(), "Summary", 1000), f.before(), f.after());
            }
        });
    /** An asset's condition history: read here; written through AssetService (which moves the asset's condition with it). */
    public record ConditionFields(UUID assetId, String assetName, LocalDate date, String condition, String source, String note, UUID ticketId) {}
    public static final Resource<ConditionFields> CONDITION_LOG = new Resource<>(
        new ResourceTable<>("infraLog", "assets/condition-log", "assets.condition_log", ConditionFields.class, "r.date DESC, r.created_at DESC").who("by").filterBy("assetId"),
        new ResourceRules<>() {
            @Override public Spec<ConditionFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return false; }
        });

    public static List<Resource<?>> all() {
        return List.of(EQUIPMENT, INVENTORY, INVENTORY_RULES, PLANT_LOGS, DG_FUEL, ELECTRICITY_BILLS, UNIT_ELECTRICITY, IMPORT_RULES, AUDITS, LOG_TYPES, LOG_ENTRIES, PLANS, LAYERS, MAP_VERSIONS, CONDITION_LOG);
    }
}
