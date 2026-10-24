package com.communityos.api.config;

import com.communityos.api.amenity.application.BookingPolicy;
import com.communityos.api.amenity.application.BookingService;
import com.communityos.api.docs.application.DocsPolicy;
import com.communityos.api.docs.application.DocumentService;
import com.communityos.api.docs.application.FileService;
import com.communityos.api.docs.application.FileService.OwnerKind;
import com.communityos.api.docs.application.port.FileRepository;
import com.communityos.api.maintenance.application.QuotationService;
import com.communityos.api.maintenance.application.TicketService;

/**
 * What files can be attached to, and each owning module's rule for reading and attaching (the file module asks; it does not know the rules).
 *   ticket     read: whoever sees the ticket · attach: the same
 *   comment    read: whoever sees its ticket, and an internal note not by residents · attach: the comment's author
 *   quotation  read / attach: whoever sees the quotation (the committee, staff and the money roles)
 *   booking    read: whoever sees the booking · attach (deposit photos): the amenities staff
 *   document   read: the document's readers · attach: a document manager
 */
public final class FileKinds {
    private FileKinds() {}
    public static void register(FileService files, FileRepository repo, TicketService tickets, QuotationService quotations, BookingService bookings, DocumentService documents) {
        files.register(new OwnerKind("maintenance.ticket", (c, id) -> tickets.get(c, id) != null, (c, id) -> tickets.get(c, id) != null));
        files.register(new OwnerKind("maintenance.comment",
            (c, id) -> repo.comment(id).filter((x) -> !(c.isResident() && "Internal".equals(x.visibility())) && tickets.get(c, x.ticketId()) != null).isPresent(),
            (c, id) -> repo.comment(id).filter((x) -> c.membership() != null && c.membership().value().equals(x.authorId())).isPresent()));
        files.register(new OwnerKind("maintenance.quotation", (c, id) -> quotations.get(c, id) != null, (c, id) -> !c.isResident() && quotations.get(c, id) != null));
        files.register(new OwnerKind("amenity.booking", (c, id) -> bookings.get(c, id) != null, (c, id) -> BookingPolicy.staff(c) && bookings.get(c, id) != null));
        files.register(new OwnerKind("docs.document", documents::visible, (c, id) -> DocsPolicy.manager(c)));
    }
    /** photo  read: members, a resident only a published event's · attach: whoever added the photo row, or the committee
     *  brochure  read: the same · attach: the cultural committee */
    public static void registerCultural(FileService files, com.communityos.api.cultural.application.port.CulturalStore store) {
        java.util.function.BiPredicate<com.communityos.api.shared.security.Caller, com.communityos.api.cultural.application.port.CulturalStore.Owner> reads =
            (c, o) -> com.communityos.api.cultural.application.CulturalPolicy.member(c) && (!c.isResident() || o.published());
        files.register(new OwnerKind("cultural.photo", (c, id) -> store.photo(id).filter((o) -> reads.test(c, o)).isPresent(),
            (c, id) -> store.photo(id).filter((o) -> com.communityos.api.cultural.application.CulturalPolicy.manager(c) || (c.membership() != null && c.membership().value().equals(o.addedBy()))).isPresent()));
        files.register(new OwnerKind("cultural.brochure", (c, id) -> store.brochure(id).filter((o) -> reads.test(c, o)).isPresent(),
            (c, id) -> com.communityos.api.cultural.application.CulturalPolicy.manager(c) && store.brochure(id).isPresent()));
    }
    /** agenda / minutes  read: whoever sees the meeting (residents only a published one) · attach: the committee */
    public static void registerGovernance(FileService files, com.communityos.api.governance.application.MeetingService meetings) {
        java.util.function.BiPredicate<com.communityos.api.shared.security.Caller, java.util.UUID> reads = (c, id) -> {
            try { return meetings.get(c, id) != null; } catch (com.communityos.api.shared.security.AccessDenied e) { return false; }
        };
        java.util.function.BiPredicate<com.communityos.api.shared.security.Caller, java.util.UUID> attaches = (c, id) -> com.communityos.api.governance.application.GovernancePolicy.manager(c) && reads.test(c, id);
        files.register(new OwnerKind("governance.agenda", reads, attaches));
        files.register(new OwnerKind("governance.minutes", reads, attaches));
    }
    /** vendor papers  read: whoever reads the vendor register (not residents) · attach: the vendor managers */
    public static void registerVendors(FileService files, org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate jdbc) {
        java.util.function.Predicate<java.util.UUID> exists = (id) -> !jdbc.query("SELECT 1 AS x FROM vendor.vendor WHERE id = CAST(:id AS uuid)", java.util.Map.of("id", id.toString()), (rs, i) -> 1).isEmpty();
        files.register(new OwnerKind("vendor.vendor", (c, id) -> com.communityos.api.vendor.application.VendorPolicy.reader(c) && exists.test(id),
            (c, id) -> com.communityos.api.vendor.application.VendorPolicy.manager(c) && exists.test(id)));
    }
    /** meter photos  read: whoever reads the readings, and the unit's people once the reading is billed · attach: the meter readers */
    public static void registerUtilities(FileService files, org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate jdbc) {
        java.util.function.Function<java.util.UUID, java.util.Optional<java.util.Map<String, Object>>> row = (id) -> jdbc.query(
            "SELECT unit_id, status FROM billing.meter_reading WHERE id = CAST(:id AS uuid)", java.util.Map.of("id", id.toString()),
            (rs, i) -> java.util.Map.<String, Object>of("unit", rs.getObject("unit_id", java.util.UUID.class), "status", rs.getString("status"))).stream().findFirst();
        files.register(new OwnerKind("billing.reading",
            (c, id) -> row.apply(id).filter((r) -> com.communityos.api.billing.UtilityResources.readers(c)
                || ("Published".equals(r.get("status")) && c.units() != null && c.units().stream().anyMatch((u) -> u.value().equals(r.get("unit"))))).isPresent(),
            (c, id) -> com.communityos.api.billing.UtilityResources.writers(c) && row.apply(id).filter((r) -> !"Published".equals(r.get("status"))).isPresent()));
    }
    /** a planned-works round  read: staff and the committee · attach (its photos): the same, while the round is not finished */
    public static void registerPlanned(FileService files, org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate jdbc) {
        java.util.function.Function<java.util.UUID, java.util.Optional<String>> status = (id) -> jdbc.query("SELECT status FROM maintenance.checklist_round WHERE id = CAST(:id AS uuid)",
            java.util.Map.of("id", id.toString()), (rs, i) -> rs.getString("status")).stream().findFirst();
        java.util.function.Predicate<com.communityos.api.shared.security.Caller> team = (c) -> c.isSuperAdmin() || c.category() == com.communityos.api.shared.security.Caller.Category.EC
            || c.category() == com.communityos.api.shared.security.Caller.Category.Staff;
        files.register(new OwnerKind("maintenance.checklist_round", (c, id) -> team.test(c) && status.apply(id).isPresent(),
            (c, id) -> team.test(c) && status.apply(id).filter((s) -> !"Done".equals(s)).isPresent()));
    }
    /** a release's QR code / payment details  read: whoever sees releases (the committee, the coordinators, the accounts) · attach: those who raise them, while it waits or is approved */
    public static void registerReleases(FileService files, org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate jdbc) {
        java.util.function.Function<java.util.UUID, java.util.Optional<String>> status = (id) -> jdbc.query("SELECT status FROM finance.release WHERE id = CAST(:id AS uuid)",
            java.util.Map.of("id", id.toString()), (rs, i) -> rs.getString("status")).stream().findFirst();
        java.util.function.Predicate<com.communityos.api.shared.security.Caller> sees = (c) -> com.communityos.api.finance.application.FinancePolicy.reader(c)
            || com.communityos.api.finance.application.FinancePolicy.raisesRelease(c, false);
        files.register(new OwnerKind("finance.release", (c, id) -> sees.test(c) && status.apply(id).isPresent(),
            (c, id) -> com.communityos.api.finance.application.FinancePolicy.raisesRelease(c, false) && status.apply(id).filter((s) -> s.equals("Waiting approval") || s.equals("Approved")).isPresent()));
    }
    /** equipment, stock, DG and electricity bills, custom log entries  read: the asset readers (not residents) · attach: the asset writers
     *  audit reports  read: as the audit (residents a published one) · attach: the coordinators */
    public static void registerAssets(FileService files, org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate jdbc) {
        java.util.Map<String, String> tables = java.util.Map.of("assets.equipment", "assets.equipment", "assets.inventory", "assets.inventory_item", "assets.dg_fuel", "assets.dg_fuel_log",
            "assets.electricity_bill", "assets.electricity_bill", "assets.log_entry", "assets.log_entry", "assets.condition_log", "assets.condition_log");   // a service visit's report
        for (var t : tables.entrySet()) {
            java.util.function.Predicate<java.util.UUID> exists = (id) -> !jdbc.query("SELECT 1 AS x FROM " + t.getValue() + " WHERE id = CAST(:id AS uuid)", java.util.Map.of("id", id.toString()), (rs, i) -> 1).isEmpty();
            files.register(new OwnerKind(t.getKey(), (c, id) -> com.communityos.api.assets.application.AssetPolicy.reader(c) && exists.test(id),
                (c, id) -> com.communityos.api.assets.application.AssetPolicy.writer(c) && exists.test(id)));
        }
        java.util.function.BiPredicate<com.communityos.api.shared.security.Caller, java.util.UUID> auditReads = (c, id) -> !jdbc.query(
            "SELECT 1 AS x FROM assets.facility_audit WHERE id = CAST(:id AS uuid) AND (:all OR visibility = 'Published')",
            java.util.Map.of("id", id.toString(), "all", com.communityos.api.assets.application.AssetPolicy.reader(c)), (rs, i) -> 1).isEmpty() && com.communityos.api.assets.application.AssetPolicy.member(c);
        files.register(new OwnerKind("assets.audit", auditReads, (c, id) -> com.communityos.api.assets.application.AssetPolicy.coordinator(c) && auditReads.test(c, id)));
    }
}
