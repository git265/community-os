package com.communityos.api.access;

import static com.communityos.api.Fixtures.*;
import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.billing.application.DuePolicy;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.identity.application.MemberPolicy;
import com.communityos.api.identity.domain.MemberView;
import com.communityos.api.property.application.UnitPolicy;
import com.communityos.api.property.domain.Unit;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Each policy's SQL and in-memory predicate must agree; these check the predicate and the shape of the SQL for every kind of caller. */
class AccessPolicyTest {
    final DuePolicy dues = new DuePolicy();
    final Due aMaint = due(UNIT_A, BLOCK_1, MAINTENANCE, "3000", LocalDate.of(2026, 10, 10));
    final Due bMaint = due(UNIT_B, BLOCK_2, MAINTENANCE, "3000", LocalDate.of(2026, 10, 10));
    final Due bWater = due(UNIT_B, BLOCK_2, WATER, "420", LocalDate.of(2026, 10, 10));

    @Test void ownerSeesOnlyTheirUnitsBillsAndChangesNone() {
        Caller c = owner(UNIT_A);
        assertTrue(dues.readScope(c).matches(aMaint)); assertFalse(dues.readScope(c).matches(bMaint)); assertFalse(dues.readScope(c).matches(bWater));
        assertTrue(dues.readScope(c).sql().contains("d.unit_id IN"));
        assertEquals(List.of(UNIT_A.value()), dues.readScope(c).params().get("s_d_unit_id"));
        assertEquals("FALSE", dues.writeScope(c).sql());
        assertTrue(dues.mayPay(c, aMaint)); assertFalse(dues.mayPay(c, bMaint));
        assertEquals("FALSE", dues.readScope(owner()).sql(), "a resident with no unit sees nothing");
    }
    @Test void financeSeesAllUtilityClerkOnlyUtilityHelpdeskNothing() {
        assertTrue(dues.readScope(treasurer()).matches(bMaint)); assertEquals("TRUE", dues.readScope(treasurer()).sql());
        Caller clerk = utilityClerk();
        assertTrue(dues.readScope(clerk).matches(bWater)); assertFalse(dues.readScope(clerk).matches(bMaint));
        assertTrue(dues.readScope(clerk).sql().contains("c.is_utility"));
        assertTrue(dues.writeScope(clerk).matches(bWater)); assertFalse(dues.writeScope(clerk).matches(aMaint));
        assertEquals("FALSE", dues.readScope(helpdesk()).sql());
        assertFalse(dues.mayPay(helpdesk(), aMaint));
    }
    @Test void blockLimitedFinanceSeesOnlyTheirBlocks() {
        Caller c = caller(Caller.Category.Staff, Set.of("accountant"), Set.of(), Set.of(BLOCK_1), Permission.MANAGE_DUES);
        assertTrue(dues.readScope(c).matches(aMaint)); assertFalse(dues.readScope(c).matches(bMaint));
        assertTrue(dues.readScope(c).sql().contains("u.block_id IN"));
        assertTrue(dues.writeScope(c).matches(aMaint)); assertFalse(dues.writeScope(c).matches(bMaint));
    }

    @Test void units() {
        UnitPolicy p = new UnitPolicy();
        Unit a = new Unit(UNIT_A, "UNIT-1", "Villa 1", BLOCK_1, "Block 1", "Villa", "Owner occupied", null, null, null, "Active", Map.of(), null, 1);
        Unit b = new Unit(UNIT_B, "UNIT-2", "Villa 2", BLOCK_2, "Block 2", "Villa", "Owner occupied", null, null, null, "Active", Map.of(), null, 1);
        assertTrue(p.readScope(owner(UNIT_A)).matches(a)); assertFalse(p.readScope(owner(UNIT_A)).matches(b));
        assertTrue(p.readScope(helpdesk()).matches(b)); assertEquals("FALSE", p.writeScope(helpdesk()).sql(), "seeing is not changing");
        Caller manager = caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of(BLOCK_2), Permission.MANAGE_UNITS);
        assertTrue(p.writeScope(manager).matches(b)); assertFalse(p.writeScope(manager).matches(a)); assertFalse(p.readScope(manager).matches(a));
        assertEquals("FALSE", p.readScope(caller(Caller.Category.Vendor, Set.of("vendor"), Set.of(), Set.of())).sql());
        assertEquals("FALSE", p.writeScope(caller(Caller.Category.Resident, Set.of("owner"), Set.of(UNIT_A), Set.of(), Permission.MANAGE_UNITS)).sql(), "never a resident");
    }

    @Test void membersAndPhoneMasking() {
        MemberPolicy p = new MemberPolicy();
        Caller me = owner(UNIT_A);
        MemberView mine = new MemberView(me.membership(), me.person(), "Me", "+919800000001", "Active", List.of(), Set.of(UNIT_A), null, null, 1);
        MemberView other = new MemberView(new MembershipId(UUID.randomUUID()), new PersonId(UUID.randomUUID()), "Them", "+919800000002", "Active", List.of(), Set.<UnitId>of(), null, null, 1);
        assertTrue(p.readScope(me).matches(mine)); assertFalse(p.readScope(me).matches(other));
        assertEquals("+919800000001", p.present(me, mine).phone());
        assertTrue(p.readScope(helpdesk()).matches(other));
        assertEquals("+91•••••002", p.present(helpdesk(), other).phone(), "staff see a masked number");
        Caller admin = caller(Caller.Category.EC, Set.of("general_secretary"), Set.of(), Set.of(), Permission.MANAGE_USERS);
        assertEquals("+919800000002", p.present(admin, other).phone());
        assertEquals("FALSE", p.writeScope(helpdesk()).sql());
    }
}
