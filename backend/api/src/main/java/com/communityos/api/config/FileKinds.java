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
}
