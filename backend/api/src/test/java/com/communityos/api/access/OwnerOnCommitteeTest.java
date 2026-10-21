package com.communityos.api.access;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.billing.application.DuePolicy;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.gate.application.GatePolicy;
import com.communityos.api.maintenance.application.TicketRules;
import com.communityos.api.maintenance.domain.TaskType;
import com.communityos.api.shared.security.Caller;
import java.time.LocalDate;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** A committee member who owns a unit does for that unit what any owner does - and no more for other units than their role allows. */
class OwnerOnCommitteeTest {
    final Caller ecOwner = Fixtures.caller(Caller.Category.EC, Set.of("committee_amenities"), Set.of(Fixtures.UNIT_A), Set.of());   // no finance permissions
    final Caller ecNoHome = Fixtures.caller(Caller.Category.EC, Set.of("committee_amenities"), Set.of(), Set.of());
    final Due mine = Fixtures.due(Fixtures.UNIT_A, null, Fixtures.MAINTENANCE, "3000", LocalDate.of(2026, 10, 15));
    final Due theirs = Fixtures.due(Fixtures.UNIT_B, null, Fixtures.MAINTENANCE, "3000", LocalDate.of(2026, 10, 15));

    @Test void billsOfTheirOwnUnit() {
        DuePolicy p = new DuePolicy();
        assertTrue(ecOwner.hasHome()); assertFalse(ecNoHome.hasHome());
        assertTrue(p.readScope(ecOwner).matches(mine), "sees their unit's bills"); assertFalse(p.readScope(ecOwner).matches(theirs), "not another unit's");
        assertTrue(p.mayPay(ecOwner, mine), "pays them online"); assertFalse(p.mayPay(ecOwner, theirs));
        assertFalse(p.readScope(ecNoHome).matches(mine));
        assertFalse(p.writeScope(ecOwner).matches(mine), "owning a unit does not make them a billing clerk");
        Caller treasurerOwner = Fixtures.caller(Caller.Category.EC, Set.of("treasurer"), Set.of(Fixtures.UNIT_A), Set.of(), com.communityos.api.shared.security.Permission.MANAGE_DUES);
        assertTrue(p.readScope(treasurerOwner).matches(theirs), "a role that sees all still does");
    }

    @Test void theirGateAndRequests() {
        record Row(com.communityos.api.shared.domain.Ids.UnitId unit) {}
        Caller staffOwner = Fixtures.caller(Caller.Category.Staff, Set.of("helpdesk"), Set.of(Fixtures.UNIT_A), Set.of());
        assertTrue(GatePolicy.byUnit(staffOwner, "x.unit_id", Row::unit).matches(new Row(Fixtures.UNIT_A)), "a staff member's own unit's visitors");
        assertFalse(GatePolicy.byUnit(staffOwner, "x.unit_id", Row::unit).matches(new Row(Fixtures.UNIT_B)));
        TaskType residentType = new TaskType(UUID.randomUUID(), "Resident Maintenance", "🔧", TaskType.RESIDENT, "Role queue (staff accepts)", "No", "No", "No", "No", "No", true, true, true);
        assertTrue(TicketRules.mayRaise(ecOwner, residentType), "raises an owner's request");
        assertFalse(TicketRules.mayRaise(ecNoHome, residentType));
    }
}
