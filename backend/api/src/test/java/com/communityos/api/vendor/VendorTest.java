package com.communityos.api.vendor;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.vendor.application.DirectoryService;
import com.communityos.api.vendor.application.VendorPolicy;
import com.communityos.api.vendor.application.port.DirectoryStore;
import com.communityos.api.vendor.domain.Directory;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The vendor register's checks, who discusses vendors, and the directory: own entries, moderators, one review per household. */
class VendorTest {
    static Caller resident(UnitId u) { return new Caller(new PersonId(UUID.randomUUID()), new MembershipId(UUID.randomUUID()), Fixtures.COMMUNITY, "Resident", Caller.Category.Resident, Set.of("owner"), Set.of(), Set.of(u), Set.of(), null, Set.of()); }

    @Test void register() {
        Caller mgr = Fixtures.caller(Caller.Category.Staff, Set.of("accountant"), Set.of(), Set.of(), Permission.MANAGE_VENDORS);
        var rules = VendorResources.VENDORS.rules();
        var ok = rules.validate(mgr, new VendorResources.VendorFields(" Aqua Pumps ", "Maintenance", "29abcde1234f1zw", "AMC", null, null, " ops@aqua.in ", null, null, null), null);
        assertEquals("Aqua Pumps", ok.name()); assertEquals("29ABCDE1234F1ZW", ok.gstin()); assertEquals("ops@aqua.in", ok.contactEmail());
        assertEquals("bad-gstin", assertThrows(DomainException.RuleViolated.class, () -> rules.validate(mgr, new VendorResources.VendorFields("X", null, "1234", null, null, null, null, null, null, null), null)).code());
        var typo = assertThrows(DomainException.RuleViolated.class, () -> rules.validate(mgr, new VendorResources.VendorFields("X", null, "29AAACI1681G1ZY", null, null, null, null, null, null, null), null));
        assertEquals("bad-gstin", typo.code()); assertTrue(typo.getMessage().contains("would be L"), typo.getMessage());
        assertNull(rules.validate(mgr, new VendorResources.VendorFields("Local Carpenter", null, " ", null, null, null, null, null, null, null), null).gstin(), "no GSTIN: an unregistered vendor");
        assertEquals("bad-category", assertThrows(DomainException.RuleViolated.class, () -> rules.validate(mgr, new VendorResources.VendorFields("X", "Cooks", null, null, null, null, null, null, null, null), null)).code());
        assertTrue(rules.mayWrite(mgr)); assertFalse(rules.mayWrite(Fixtures.helpdesk()));
        assertEquals("FALSE", rules.readScope(Fixtures.owner(Fixtures.UNIT_A)).sql(), "residents do not see the vendor register");
        assertTrue(VendorPolicy.discusses(Fixtures.caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of())));
        assertFalse(VendorPolicy.discusses(Fixtures.helpdesk()));
        assertFalse(VendorResources.COMMENTS.rules().deletable(new VendorResources.CommentFields(UUID.randomUUID(), "x")), "comments stay");
    }

    @Test void directory() {
        Store store = new Store(); Fixtures.Audit audit = new Fixtures.Audit();
        DirectoryService ds = new DirectoryService(store, audit, Tx.direct());
        Caller asha = resident(Fixtures.UNIT_A), ravi = resident(Fixtures.UNIT_A), meena = resident(Fixtures.UNIT_B), ec = Fixtures.caller(Caller.Category.EC, Set.of("president"), Set.of(), Set.of());
        Caller vendor = Fixtures.caller(Caller.Category.Vendor, Set.of("vendor"), Set.of(), Set.of());
        assertThrows(AccessDenied.class, () -> ds.add(vendor, fields("Raju", null)));
        Directory.Contact raju = ds.add(asha, fields("Raju electrician", "+91 98450 12345"));
        assertEquals(asha.membership().value(), raju.addedById); assertEquals(Fixtures.UNIT_A.value(), raju.addedByUnitId, "added from the resident's unit");
        assertEquals("bad-phone", assertThrows(DomainException.RuleViolated.class, () -> ds.add(asha, fields("X", "call me"))).code());
        assertThrows(AccessDenied.class, () -> ds.change(meena, raju.id, raju.version, fields("Raju", null)), "not hers");
        var hide = new DirectoryService.ContactFields("Raju electrician", null, null, null, null, null, null, "Hidden", null);
        assertThrows(AccessDenied.class, () -> ds.change(asha, raju.id, raju.version, hide), "only moderators hide");
        assertEquals("reason-required", assertThrows(DomainException.RuleViolated.class, () -> ds.change(ec, raju.id, raju.version, hide)).code());

        ds.review(asha, raju.id, new DirectoryService.ReviewFields(5, "Quick and tidy", "Yes"));
        assertEquals("unit-reviewed", assertThrows(DomainException.RuleViolated.class, () -> ds.review(ravi, raju.id, new DirectoryService.ReviewFields(2, null, null))).code(), "one per household");
        ds.review(meena, raju.id, new DirectoryService.ReviewFields(4, null, "No"));
        Directory.Review again = ds.review(asha, raju.id, new DirectoryService.ReviewFields(3, "Late this time", "Yes"));
        assertEquals(3, again.rating); assertEquals(2, store.reviews.size(), "rewritten, not added");
        assertEquals("bad-rating", assertThrows(DomainException.RuleViolated.class, () -> ds.review(ec, raju.id, new DirectoryService.ReviewFields(6, null, null))).code());
        Directory.Contact listed = ds.list(meena).get(0);
        assertEquals(new BigDecimal("3.5"), listed.rating); assertEquals(2, listed.reviews); assertEquals(1, listed.recommends);
        assertThrows(AccessDenied.class, () -> ds.removeReview(meena, again.id));
        Directory.Contact hidden = ds.change(ec, raju.id, store.contacts.get(raju.id).version, new DirectoryService.ContactFields("Raju electrician", null, null, null, null, null, null, "Hidden", "Complaints"));
        assertEquals(ec.membership().value(), hidden.hiddenById);
        assertTrue(ds.list(meena).isEmpty(), "hidden from residents"); assertEquals(1, ds.list(asha).size(), "but not from who added it"); assertEquals(1, ds.list(ec).size());
        assertEquals("hidden", assertThrows(DomainException.RuleViolated.class, () -> ds.review(meena, raju.id, new DirectoryService.ReviewFields(1, null, null))).code());
        ds.removeReview(ec, again.id);
        ds.remove(asha, raju.id, store.contacts.get(raju.id).version);
        assertTrue(store.contacts.isEmpty());
    }
    static DirectoryService.ContactFields fields(String name, String phone) { return new DirectoryService.ContactFields(name, "Electrician", phone, null, null, null, null, null, null); }

    static final class Store implements DirectoryStore {
        final Map<UUID, Directory.Contact> contacts = new LinkedHashMap<>(); final Map<UUID, Directory.Review> reviews = new LinkedHashMap<>();
        Directory.Contact view(Directory.Contact c, UUID me) {
            Directory.Contact o = copy(c);
            List<Directory.Review> rs = reviews.values().stream().filter((r) -> r.contactId.equals(c.id)).toList();
            o.reviews = rs.size(); o.recommends = (int) rs.stream().filter((r) -> "Yes".equals(r.recommend)).count();
            o.rating = rs.isEmpty() ? null : BigDecimal.valueOf(rs.stream().mapToInt((r) -> r.rating).sum()).divide(BigDecimal.valueOf(rs.size()), 1, RoundingMode.HALF_UP);
            o.myReviewId = rs.stream().filter((r) -> r.authorId.equals(me)).map((r) -> r.id).findFirst().orElse(null);
            return o;
        }
        @Override public List<Directory.Contact> contacts(boolean withHidden, UUID me) { return contacts.values().stream().filter((c) -> withHidden || !c.hidden() || me.equals(c.addedById)).map((c) -> view(c, me)).toList(); }
        @Override public Optional<Directory.Contact> contact(UUID id, UUID me, boolean lock) { return Optional.ofNullable(contacts.get(id)).map((c) -> view(c, me)); }
        @Override public void insert(Directory.Contact c) { c.id = UUID.randomUUID(); c.version = 1; contacts.put(c.id, copy(c)); }
        @Override public boolean update(Directory.Contact c) { if (contacts.get(c.id).version != c.version) return false; c.version++; contacts.put(c.id, copy(c)); return true; }
        @Override public boolean deleteContact(UUID id, long version) { reviews.values().removeIf((r) -> r.contactId.equals(id)); return contacts.remove(id) != null; }
        @Override public List<Directory.Review> reviews(UUID contactId) { return reviews.values().stream().filter((r) -> r.contactId.equals(contactId)).toList(); }
        @Override public Optional<Directory.Review> review(UUID id) { return Optional.ofNullable(reviews.get(id)); }
        @Override public Optional<Directory.Review> reviewBy(UUID contactId, UUID authorId) { return reviews.values().stream().filter((r) -> r.contactId.equals(contactId) && r.authorId.equals(authorId)).findFirst(); }
        @Override public Optional<Directory.Review> reviewOfUnit(UUID contactId, UUID unitId) { return reviews.values().stream().filter((r) -> r.contactId.equals(contactId) && unitId.equals(r.unitId)).findFirst(); }
        @Override public void insert(Directory.Review r) { r.id = UUID.randomUUID(); r.version = 1; r.author = "someone"; reviews.put(r.id, r); }
        @Override public boolean update(Directory.Review r) { r.version++; reviews.put(r.id, r); return true; }
        @Override public boolean deleteReview(UUID id) { return reviews.remove(id) != null; }
        @Override public String unitNo(UUID unitId) { return "Villa 1"; }
        static Directory.Contact copy(Directory.Contact c) {
            Directory.Contact o = new Directory.Contact();
            o.id = c.id; o.shortId = c.shortId; o.name = c.name; o.category = c.category; o.phone = c.phone; o.area = c.area; o.rate = c.rate; o.notes = c.notes; o.status = c.status;
            o.hiddenReason = c.hiddenReason; o.hiddenById = c.hiddenById; o.registryId = c.registryId; o.addedById = c.addedById; o.addedByUnitId = c.addedByUnitId; o.version = c.version;
            return o;
        }
    }
}
