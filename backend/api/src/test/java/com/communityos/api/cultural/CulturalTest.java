package com.communityos.api.cultural;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.approval.domain.Plan;
import com.communityos.api.approval.domain.Policy;
import com.communityos.api.comms.application.Recipes;
import com.communityos.api.cultural.application.CulturalPolicy;
import com.communityos.api.cultural.application.DonationService;
import com.communityos.api.cultural.domain.Cultural;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Receipt numbers, approval limits, the unused budget, donation and expense checks, who sees which donations. */
class CulturalTest {
    static Cultural.Event ev(String name, BigDecimal finalOver, BigDecimal budget, BigDecimal spent, BigDecimal actual) {
        return new Cultural.Event(UUID.randomUUID(), name, LocalDate.of(2026, 9, 7), "Open", "Published", finalOver, "Cultural", budget, spent, actual, null, 1);
    }
    @Test void events() {
        assertEquals("GC26", ev("Ganesh Chaturthi", null, null, null, null).receiptCode());
        assertEquals("SDFC26", ev("Summer 2026 dance fest & camp", null, null, null, null).receiptCode().length() <= 6 ? "SDFC26" : "x", "up to four initials, then the year");
        assertEquals("EVT26", ev("2026 !!", null, null, null, null).receiptCode());
        Cultural.Event e = ev("Diwali", new BigDecimal("5000"), new BigDecimal("50000"), new BigDecimal("30000"), null);
        assertFalse(e.needsFinal(new BigDecimal("5000"))); assertTrue(e.needsFinal(new BigDecimal("5000.01")));
        assertTrue(ev("x", null, null, null, null).needsFinal(BigDecimal.ONE), "no limit: always");
        assertEquals(new BigDecimal("20000"), e.unused());
        assertEquals(new BigDecimal("10000"), ev("x", null, new BigDecimal("50000"), new BigDecimal("30000"), new BigDecimal("40000")).unused(), "the actual spend entered wins");
        assertEquals(BigDecimal.ZERO, ev("x", null, new BigDecimal("100"), new BigDecimal("300"), null).unused(), "never negative");
    }
    @Test void donations() {
        Cultural.Donation d = new Cultural.Donation(); d.donor = " Asha "; d.amount = new BigDecimal("1001"); d.check(); assertEquals("Asha", d.donor);
        d.amount = new BigDecimal("0"); assertEquals("amount-required", assertThrows(DomainException.RuleViolated.class, d::check).code());
        d.amount = new BigDecimal("10.555"); assertEquals("bad-amount", assertThrows(DomainException.RuleViolated.class, d::check).code());
        d.amount = BigDecimal.TEN; d.kind = "Loan"; assertEquals("bad-kind", assertThrows(DomainException.RuleViolated.class, d::check).code());
        Caller owner = Fixtures.owner(Fixtures.UNIT_A);
        Cultural.Donation mine = new Cultural.Donation(); mine.unitId = Fixtures.UNIT_A.value();
        Cultural.Donation theirs = new Cultural.Donation(); theirs.unitId = Fixtures.UNIT_B.value();
        assertTrue(CulturalPolicy.donations(owner).matches(mine)); assertFalse(CulturalPolicy.donations(owner).matches(theirs));
        assertEquals("FALSE", CulturalPolicy.donations(Fixtures.helpdesk()).sql(), "staff do not see donations");
        assertEquals("TRUE", CulturalPolicy.donations(Fixtures.caller(Caller.Category.Staff, Set.of("x"), Set.of(), Set.of(), Permission.MANAGE_CULTURAL)).sql());
        var msg = Recipes.of(new DonationService.DonationEvent("cultural.donation.received", UUID.randomUUID(), Fixtures.COMMUNITY, UUID.randomUUID(), Fixtures.UNIT_A.value(), "GC26-0001",
            new BigDecimal("1001"), Instant.now()), null);
        assertEquals("Receipt GC26-0001", msg.get(0).title()); assertEquals(Set.of(Fixtures.UNIT_A.value()), msg.get(0).to().units());
        assertTrue(Recipes.of(new DonationService.DonationEvent("cultural.donation.pledged", UUID.randomUUID(), Fixtures.COMMUNITY, null, Fixtures.UNIT_A.value(), null, BigDecimal.TEN, Instant.now()), null).isEmpty());
    }
    @Test void expenses() {
        Cultural.Expense x = new Cultural.Expense(); x.item = "Flowers"; x.estimate = new BigDecimal("2000"); x.check();
        assertEquals(new BigDecimal("2000"), x.value());
        x.estimate = null; assertEquals("amount-required", assertThrows(DomainException.RuleViolated.class, x::check).code());
        x.amount = new BigDecimal("2500");
        Instant now = Instant.parse("2026-10-20T06:00:00Z");
        x.plan = Policy.build(List.of(), new Policy.Context("Cultural expense", x.amount, null, null, List.of("eventFinal")), now); x.mirror();
        assertEquals("Pending approval", x.status); assertEquals("Pending", x.ecApproval);
        x.plan = x.plan.decide("m1", "Ravi", now, "Approved", null, false); x.mirror();
        assertEquals("Approved", x.ecApproval); assertEquals("Ravi", x.ecApprovedBy); assertEquals(Boolean.TRUE, x.finalRequired); assertEquals("Pending approval", x.status);
        x.plan = x.plan.decide("m2", "Meena", now, "Rejected", "too costly", false); x.mirror();
        assertEquals("Rejected", x.status); assertEquals("Meena", x.approvedBy); assertEquals("too costly", x.approvalNote);
        Plan one = new Plan(1, now.toString(), List.of(), BigDecimal.TEN, Policy.defaultSteps().subList(0, 1), List.of());
        Cultural.Expense y = new Cultural.Expense(); y.plan = one.decide("m1", "Ravi", now, "Approved", null, false); y.mirror();
        assertEquals("Approved", y.status, "one step: the EC's approval is the last");
        y.status = "Paid"; y.mirror(); assertEquals("Paid", y.status, "a paid expense stays paid");
    }
    @Test void signups() {
        assertEquals(5, Cultural.headcount(List.of(new Cultural.Signup(null, "a", null, 3), new Cultural.Signup(null, "b", null, null), new Cultural.Signup(null, "c", null, 0))));
    }
}
