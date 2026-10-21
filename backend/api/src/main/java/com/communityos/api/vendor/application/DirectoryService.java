package com.communityos.api.vendor.application;

import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.vendor.application.port.DirectoryStore;
import com.communityos.api.vendor.domain.Directory;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/**
 * The community's service directory. Any member (not a vendor) recommends someone and reviews them; you change or remove what you added;
 * moderators hide (with a reason) or remove anyone's. A review is 1 to 5 stars: one per household for residents (the first one from a unit
 * stands; its author edits it), one per person for staff. A contact's rating is the average of its reviews, worked out when read.
 */
public final class DirectoryService {
    public record ContactFields(String name, String category, String phone, String area, String rate, String notes, UUID registryId, String status, String hiddenReason) {}
    public record ReviewFields(Integer rating, String comment, String recommend) {}

    private final DirectoryStore store; private final AuditWriter audit; private final Tx tx;
    public DirectoryService(DirectoryStore store, AuditWriter audit, Tx tx) { this.store = store; this.audit = audit; this.tx = tx; }

    static UUID me(Caller c) { return c.membership() == null ? null : c.membership().value(); }
    static void member(Caller c) { if (!VendorPolicy.member(c)) throw new AccessDenied("Members only"); }
    /** The unit a resident speaks for (their first unit); staff speak for themselves. */
    static UUID unitOf(Caller c) {
        if (!c.hasHome()) return null;
        return c.units().stream().map((u) -> u.value()).min(Comparator.comparing(UUID::toString)).orElseThrow();
    }

    public List<Directory.Contact> list(Caller c) { member(c); return store.contacts(VendorPolicy.moderator(c), me(c)); }
    public Directory.Contact get(Caller c, UUID id) {
        member(c);
        Directory.Contact x = store.contact(id, me(c), false).orElseThrow(AccessDenied.NotVisible::new);
        if (x.hidden() && !VendorPolicy.moderator(c) && !mine(c, x)) throw new AccessDenied.NotVisible();
        return x;
    }

    public Directory.Contact add(Caller c, ContactFields f) {
        member(c);
        Directory.Contact x = new Directory.Contact();
        copy(f, x); x.status = "Active"; x.hiddenReason = null;
        x.check();
        x.addedById = me(c); x.addedByUnitId = unitOf(c);
        return tx.inTx(() -> {
            store.insert(x);
            audit.write(c, AuditWriter.Action.Create, "vendor.service_contact", x.id, x.shortId, x.addedByUnitId, "Added " + x.name + " to the directory", List.of());
            return store.contact(x.id, me(c), false).orElseThrow();
        });
    }

    public Directory.Contact change(Caller c, UUID id, long version, ContactFields f) {
        member(c);
        return tx.inTx(() -> {
            Directory.Contact x = store.contact(id, me(c), true).orElseThrow(() -> new DomainException.NotFound("Contact"));
            boolean mod = VendorPolicy.moderator(c);
            if (!mod && !mine(c, x)) throw new AccessDenied("You can only change contacts you added - leave a review instead");
            if (x.version != version) throw new DomainException.Conflict("The contact");
            String was = x.status;
            copy(f, x);
            if (f.status() == null) x.status = was;
            if (!was.equals(x.status) && !mod) throw new AccessDenied("Only moderators hide or restore a contact");
            if (x.hidden() && !was.equals(x.status) && (f.hiddenReason() == null || f.hiddenReason().isBlank()))
                throw new DomainException.RuleViolated("reason-required", "Say why the contact is hidden");
            x.check();
            x.hiddenById = x.hidden() ? (was.equals("Hidden") ? x.hiddenById : me(c)) : null;
            if (!store.update(x)) throw new DomainException.Conflict("The contact");
            audit.write(c, AuditWriter.Action.Update, "vendor.service_contact", x.id, x.shortId, x.addedByUnitId,
                was.equals(x.status) ? "Changed " + x.name : (x.hidden() ? "Hid " + x.name + ": " + x.hiddenReason : "Restored " + x.name), List.of());
            return store.contact(id, me(c), false).orElseThrow();
        });
    }

    public void remove(Caller c, UUID id, long version) {
        member(c);
        tx.run(() -> {
            Directory.Contact x = store.contact(id, me(c), true).orElseThrow(() -> new DomainException.NotFound("Contact"));
            if (!VendorPolicy.moderator(c) && !mine(c, x)) throw new AccessDenied("You can only remove contacts you added");
            if (!store.deleteContact(id, version)) throw new DomainException.Conflict("The contact");
            audit.write(c, AuditWriter.Action.Delete, "vendor.service_contact", x.id, x.shortId, x.addedByUnitId, "Removed " + x.name + " from the directory", List.of());
        });
    }

    public List<Directory.Review> reviews(Caller c, UUID contactId) { get(c, contactId); return store.reviews(contactId); }

    /** Write (or rewrite) my review of a contact. */
    public Directory.Review review(Caller c, UUID contactId, ReviewFields f) {
        member(c);
        return tx.inTx(() -> {
            Directory.Contact x = store.contact(contactId, me(c), true).orElseThrow(AccessDenied.NotVisible::new);
            if (x.hidden()) throw new DomainException.RuleViolated("hidden", x.name + " is hidden from the directory");
            Directory.Review r = store.reviewBy(contactId, me(c)).orElse(null);
            UUID unit = unitOf(c);
            if (r == null && unit != null) {
                Directory.Review theirs = store.reviewOfUnit(contactId, unit).orElse(null);
                if (theirs != null) throw new DomainException.RuleViolated("unit-reviewed", store.unitNo(unit) + " has already reviewed " + x.name + " (by " + theirs.author + ") - one review per household");
            }
            boolean fresh = r == null;
            if (fresh) { r = new Directory.Review(); r.contactId = contactId; r.authorId = me(c); r.unitId = unit; }
            r.rating = f.rating() == null ? 0 : f.rating(); r.comment = f.comment(); r.recommend = f.recommend();
            r.check();
            if (fresh) store.insert(r); else if (!store.update(r)) throw new DomainException.Conflict("Your review");
            audit.write(c, fresh ? AuditWriter.Action.Create : AuditWriter.Action.Update, "vendor.contact_review", r.id, r.shortId, unit, r.rating + "★ for " + x.name, List.of());
            return store.review(r.id).orElseThrow();
        });
    }

    public void removeReview(Caller c, UUID reviewId) {
        member(c);
        tx.run(() -> {
            Directory.Review r = store.review(reviewId).orElseThrow(() -> new DomainException.NotFound("Review"));
            if (!VendorPolicy.moderator(c) && !r.authorId.equals(me(c))) throw new AccessDenied("You can only delete your own review");
            store.deleteReview(reviewId);
            audit.write(c, AuditWriter.Action.Delete, "vendor.contact_review", r.id, r.shortId, r.unitId, "Review removed", List.of());
        });
    }

    static boolean mine(Caller c, Directory.Contact x) { return x.addedById != null && x.addedById.equals(me(c)); }
    static void copy(ContactFields f, Directory.Contact x) {
        x.name = f.name(); x.category = f.category(); x.phone = f.phone(); x.area = f.area(); x.rate = f.rate(); x.notes = f.notes(); x.registryId = f.registryId();
        if (f.status() != null) x.status = f.status();
        x.hiddenReason = f.hiddenReason() != null ? f.hiddenReason() : x.hiddenReason;
    }
}
