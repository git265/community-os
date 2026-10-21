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
    /** equipment, stock, DG and electricity bills, custom log entries  read: the asset readers (not residents) · attach: the asset writers
     *  audit reports  read: as the audit (residents a published one) · attach: the coordinators */
    public static void registerAssets(FileService files, org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate jdbc) {
        java.util.Map<String, String> tables = java.util.Map.of("assets.equipment", "assets.equipment", "assets.inventory", "assets.inventory_item", "assets.dg_fuel", "assets.dg_fuel_log",
            "assets.electricity_bill", "assets.electricity_bill", "assets.log_entry", "assets.log_entry");
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
