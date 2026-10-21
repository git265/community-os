package com.communityos.api.identity.application;

import com.communityos.api.identity.domain.MemberView;
import com.communityos.api.shared.access.AccessPolicy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;

/**
 * Who sees which members: the committee, staff and member managers see the directory; a resident or vendor sees only themselves.
 * Only MANAGE_USERS (or the Super Admin) changes members. Phone numbers are shown only to member managers and to the member themselves.
 */
public final class MemberPolicy implements AccessPolicy<MemberView> {
    @Override public Spec<MemberView> readScope(Caller c) {
        if (c.isSuperAdmin() || c.has(Permission.MANAGE_USERS) || c.category() == Caller.Category.EC || c.category() == Caller.Category.Staff) return Spec.all();
        if (c.membership() == null) return Spec.none();
        return Spec.eq("m.id", c.membership().value(), (m) -> m.id().equals(c.membership()));
    }
    @Override public Spec<MemberView> writeScope(Caller c) {
        return c.isSuperAdmin() || c.has(Permission.MANAGE_USERS) ? Spec.all() : Spec.none();
    }
    public MemberView present(Caller c, MemberView m) {
        boolean seesPhone = c.isSuperAdmin() || c.has(Permission.MANAGE_USERS) || m.id().equals(c.membership());
        return seesPhone ? m : m.withPhone(m.phone() == null ? null : m.phone().substring(0, 3) + "•••••" + m.phone().substring(m.phone().length() - 3));
    }
}
