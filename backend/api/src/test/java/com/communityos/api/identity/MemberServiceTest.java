package com.communityos.api.identity;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.identity.application.MemberService;
import com.communityos.api.identity.application.port.MemberRepository;
import com.communityos.api.identity.application.port.RoleCatalog;
import com.communityos.api.identity.domain.MemberView;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** No privilege escalation through member management. */
class MemberServiceTest {
    final Map<String, RoleCatalog.RoleRef> roles = new LinkedHashMap<>();
    final MemberView target = new MemberView(new MembershipId(UUID.randomUUID()), new PersonId(UUID.randomUUID()), "Ravi", "+919800000009", "Active",
        List.of(new MemberView.Role("owner", "Owner", true)), Set.<UnitId>of(), null, null, 3);
    final List<String> saved = new ArrayList<>();
    final MemberService svc;

    MemberServiceTest() {
        roles.put("owner", new RoleCatalog.RoleRef(UUID.randomUUID(), "owner", "Owner", Caller.Category.Resident, Set.of()));
        roles.put("treasurer", new RoleCatalog.RoleRef(UUID.randomUUID(), "treasurer", "Treasurer", Caller.Category.EC, EnumSet.of(Permission.MANAGE_DUES, Permission.MANAGE_LEDGER)));
        roles.put("helpdesk", new RoleCatalog.RoleRef(UUID.randomUUID(), "helpdesk", "Helpdesk", Caller.Category.Staff, EnumSet.of(Permission.MANAGE_TICKETS)));
        roles.put("super_admin", new RoleCatalog.RoleRef(UUID.randomUUID(), "super_admin", "Super Admin", Caller.Category.EC, EnumSet.allOf(Permission.class)));
        MemberRepository repo = new MemberRepository() {
            public Page<MemberView> find(Spec<MemberView> s, Filter f, PageQuery p) { return new Page<>(List.of(target), 1, 50, 0); }
            public Optional<MemberView> findById(MembershipId id, Spec<MemberView> s) { return id.equals(target.id()) ? Optional.of(target).filter(s::matches) : Optional.empty(); }
            public MembershipId insert(PersonId p, String n) { return new MembershipId(UUID.randomUUID()); }
            public boolean replaceRoles(MembershipId id, List<UUID> r, UUID primary, long v) { if (v != target.version()) return false; saved.add(id + ":" + r.size()); return true; }
            public boolean setStatus(MembershipId id, String s, long v) { return v == target.version(); }
            public void addOccupant(UnitId u, PersonId p, String r, String n, String ph) {}
        };
        RoleCatalog catalog = new RoleCatalog() {
            public Map<String, RoleCatalog.RoleRef> byCodes(java.util.Collection<String> codes) { Map<String, RoleCatalog.RoleRef> m = new LinkedHashMap<>(); for (String c : codes) if (roles.containsKey(c)) m.put(c, roles.get(c)); return m; }
            public List<RoleCatalog.RoleRef> all() { return List.copyOf(roles.values()); }
        };
        svc = new MemberService(repo, catalog, new AuthTest.People(), new AuthTest.Refreshes(), new com.communityos.api.shared.security.CallerLoader() {
            public Optional<Caller> load(PersonId p, com.communityos.api.shared.domain.Ids.CommunityId c, MembershipId m) { return Optional.empty(); }
            public void evict(MembershipId m) {}
        }, new Fixtures.Audit(), Tx.direct(), Fixtures.CLOCK, "+91");
    }

    Caller secretary() { return Fixtures.caller(Caller.Category.EC, Set.of("general_secretary"), Set.of(), Set.of(), Permission.MANAGE_USERS, Permission.MANAGE_TICKETS); }

    @Test void aMemberManagerCannotHandOutPowersTheyDoNotHave() {
        Caller c = secretary();
        assertThrows(AccessDenied.class, () -> svc.changeRoles(c, target.id(), new MemberService.ChangeRoles(List.of("treasurer"), null), 3), "treasurer has MANAGE_DUES");
        assertThrows(AccessDenied.class, () -> svc.changeRoles(c, target.id(), new MemberService.ChangeRoles(List.of("super_admin"), null), 3));
        svc.changeRoles(c, target.id(), new MemberService.ChangeRoles(List.of("helpdesk", "owner"), "helpdesk"), 3);
        assertEquals(1, saved.size());
        assertThrows(com.communityos.api.shared.domain.DomainException.Conflict.class, () -> svc.changeRoles(c, target.id(), new MemberService.ChangeRoles(List.of("owner"), null), 2), "stale version");
        assertThrows(com.communityos.api.shared.domain.DomainException.class, () -> svc.changeRoles(c, target.id(), new MemberService.ChangeRoles(List.of("no_such_role"), null), 3));
    }
    @Test void nobodyChangesTheirOwnRolesAndResidentsChangeNothing() {
        Caller c = Fixtures.caller(Caller.Category.EC, Set.of("super_admin"), Set.of(), Set.of());
        Caller me = new Caller(c.person(), target.id(), c.community(), "me", c.category(), c.roleCodes(), c.permissions(), c.units(), c.blocks(), null, Set.of());
        assertThrows(AccessDenied.class, () -> svc.changeRoles(me, target.id(), new MemberService.ChangeRoles(List.of("super_admin"), null), 3));
        assertThrows(AccessDenied.class, () -> svc.deactivate(me, target.id(), 3));
        assertThrows(AccessDenied.class, () -> svc.changeRoles(Fixtures.owner(), target.id(), new MemberService.ChangeRoles(List.of("owner"), null), 3));
        svc.changeRoles(c, target.id(), new MemberService.ChangeRoles(List.of("treasurer"), null), 3);
        assertEquals(1, saved.size(), "the Super Admin can");
    }
}
