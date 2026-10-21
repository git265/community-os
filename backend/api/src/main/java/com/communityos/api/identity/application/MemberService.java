package com.communityos.api.identity.application;

import com.communityos.api.identity.application.port.MemberRepository;
import com.communityos.api.identity.application.port.PersonDirectory;
import com.communityos.api.identity.application.port.RefreshTokenStore;
import com.communityos.api.identity.application.port.RoleCatalog;
import com.communityos.api.identity.application.port.RoleCatalog.RoleRef;
import com.communityos.api.identity.domain.MemberView;
import com.communityos.api.identity.domain.Phone;
import com.communityos.api.shared.access.Guard;
import com.communityos.api.shared.access.GuardChain;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.CallerLoader;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Use cases for members (the "users" of a community). */
public final class MemberService {
    public record AddMember(String phone, String fullName, String displayName, String roleCode, UnitId unitId, String relation) {}
    public record ChangeRoles(List<String> roleCodes, String primaryRoleCode) {}

    private final MemberRepository members; private final RoleCatalog roles; private final PersonDirectory people; private final RefreshTokenStore refreshTokens;
    private final CallerLoader callers; private final AuditWriter audit; private final Tx tx; private final Clock clock; private final String defaultCountryCode;
    private final MemberPolicy policy = new MemberPolicy();

    private final Guard<Object> canManage = GuardChain.of(GuardChain.anyPermission("You cannot manage members", Permission.MANAGE_USERS));

    public MemberService(MemberRepository members, RoleCatalog roles, PersonDirectory people, RefreshTokenStore refreshTokens, CallerLoader callers,
                         AuditWriter audit, Tx tx, Clock clock, String defaultCountryCode) {
        this.members = members; this.roles = roles; this.people = people; this.refreshTokens = refreshTokens; this.callers = callers; this.audit = audit;
        this.tx = tx; this.clock = clock; this.defaultCountryCode = defaultCountryCode;
    }

    public Page<MemberView> list(Caller c, MemberRepository.Filter filter, PageQuery page) {
        return members.find(policy.readScope(c), filter, page).map((m) -> policy.present(c, m));
    }
    public MemberView get(Caller c, MembershipId id) {
        return members.findById(id, policy.readScope(c)).map((m) -> policy.present(c, m)).orElseThrow(AccessDenied.NotVisible::new);
    }

    public MemberView add(Caller c, AddMember cmd) {
        canManage.check(c, cmd);
        Phone phone = Phone.parse(cmd.phone(), defaultCountryCode);
        String name = clean(cmd.fullName(), "Full name", 120);
        RoleRef role = rolesOf(List.of(cmd.roleCode())).get(cmd.roleCode());
        mayGrant(c, List.of(role));
        if (cmd.unitId() != null && !List.of("Owner", "Co-owner", "Tenant", "Family", "Caretaker").contains(cmd.relation()))
            throw new DomainException.RuleViolated("bad-relation", "Relation must be Owner, Co-owner, Tenant, Family or Caretaker");
        PersonId person = people.findOrCreate(phone, name);                       // global row (platform connection); harmless if the rest fails
        MembershipId id = tx.inTx(() -> {
            MembershipId m;
            try { m = members.insert(person, cmd.displayName() == null || cmd.displayName().isBlank() ? name : clean(cmd.displayName(), "Display name", 120)); }
            catch (org.springframework.dao.DuplicateKeyException e) { throw new DomainException.Conflict("This person is already a member; they"); }
            members.replaceRoles(m, List.of(role.id()), role.id(), 1);
            if (cmd.unitId() != null) members.addOccupant(cmd.unitId(), person, cmd.relation(), name, phone.e164());
            audit.write(c, AuditWriter.Action.Create, "identity.membership", m.value(), null, cmd.unitId() == null ? null : cmd.unitId().value(),
                "Added member " + name + " as " + role.name(), List.of(new AuditWriter.Change("role", null, role.code())));
            return m;
        });
        return get(c, id);
    }

    public MemberView changeRoles(Caller c, MembershipId id, ChangeRoles cmd, long expectedVersion) {
        canManage.check(c, cmd);
        if (id.equals(c.membership())) throw new AccessDenied("You cannot change your own roles");
        if (cmd.roleCodes() == null || cmd.roleCodes().isEmpty() || cmd.roleCodes().size() > 5) throw new DomainException.RuleViolated("bad-roles", "Give 1 to 5 roles");
        Set<String> codes = new LinkedHashSet<>(cmd.roleCodes());
        String primary = cmd.primaryRoleCode() == null ? cmd.roleCodes().get(0) : cmd.primaryRoleCode();
        if (!codes.contains(primary)) throw new DomainException.RuleViolated("bad-roles", "The primary role must be one of the roles");
        Map<String, RoleRef> found = rolesOf(codes);
        MemberView before = members.findById(id, policy.writeScope(c)).orElseThrow(AccessDenied.NotVisible::new);
        List<RoleRef> current = new ArrayList<>(rolesOf(before.roles().stream().map(MemberView.Role::code).toList()).values());
        mayGrant(c, found.values());
        mayGrant(c, current);                                                     // and may take away only roles they could have given
        tx.run(() -> {
            if (!members.replaceRoles(id, found.values().stream().map(RoleRef::id).toList(), found.get(primary).id(), expectedVersion)) throw new DomainException.Conflict("This member");
            audit.write(c, AuditWriter.Action.Update, "identity.membership", id.value(), null, null, "Changed roles of " + before.displayName(),
                List.of(new AuditWriter.Change("roles", String.join(", ", before.roles().stream().map(MemberView.Role::code).toList()), String.join(", ", codes))));
        });
        callers.evict(id);
        return get(c, id);
    }

    public MemberView deactivate(Caller c, MembershipId id, long expectedVersion) {
        canManage.check(c, id);
        if (id.equals(c.membership())) throw new AccessDenied("You cannot deactivate yourself");
        MemberView before = members.findById(id, policy.writeScope(c)).orElseThrow(AccessDenied.NotVisible::new);
        mayGrant(c, rolesOf(before.roles().stream().map(MemberView.Role::code).toList()).values());
        tx.run(() -> {
            if (!members.setStatus(id, "Inactive", expectedVersion)) throw new DomainException.Conflict("This member");
            audit.write(c, AuditWriter.Action.Update, "identity.membership", id.value(), null, null, "Deactivated " + before.displayName(),
                List.of(new AuditWriter.Change("status", before.status(), "Inactive")));
        });
        refreshTokens.revokeAllOfMembership(id.value(), "deactivated", clock.instant());   // signed out everywhere at the next refresh
        callers.evict(id);                                                                  // and refused on the very next call on this instance
        return get(c, id);
    }

    /** No privilege escalation: a member manager can only hand out (or take away) roles whose permissions they hold themselves. */
    static void mayGrant(Caller c, java.util.Collection<RoleRef> rs) {
        if (c.isSuperAdmin()) return;
        for (RoleRef r : rs) {
            if (r.code().equals("super_admin")) throw new AccessDenied("Only the Super Admin can give or take the Super Admin role");
            if (!c.permissions().containsAll(r.permissions())) throw new AccessDenied("You cannot give or take the " + r.name() + " role: it has permissions you do not have");
        }
    }

    private Map<String, RoleRef> rolesOf(java.util.Collection<String> codes) {
        Map<String, RoleRef> found = roles.byCodes(codes);
        for (String code : codes) if (!found.containsKey(code)) throw new DomainException.RuleViolated("unknown-role", "There is no role \"" + code + "\"");
        return found;
    }
    private static String clean(String s, String what, int max) {
        if (s == null || s.isBlank()) throw new DomainException.RuleViolated("required", what + " is required");
        String t = s.strip().replaceAll("\\s+", " ");
        if (t.length() > max) throw new DomainException.RuleViolated("too-long", what + " is too long");
        return t;
    }
}
