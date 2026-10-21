package com.communityos.api.approval;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.approval.application.Approvers;
import com.communityos.api.approval.application.PlanCodec;
import com.communityos.api.approval.domain.Plan;
import com.communityos.api.approval.domain.Policy;
import com.communityos.api.maintenance.domain.Quotation;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.web.Json;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The approval engine (plans built from rules, decisions, the two slots) and who may decide. Pure: no database. */
class ApprovalTest {
    static final Instant NOW = Instant.parse("2026-10-20T10:00:00Z");
    final Caller treasurer = Fixtures.treasurer();
    final Caller president = Fixtures.caller(Caller.Category.EC, Set.of("president"), Set.of(), Set.of());
    final Caller secretary = Fixtures.caller(Caller.Category.EC, Set.of("general_secretary"), Set.of(), Set.of());
    final Caller fm = Fixtures.caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of());
    final Approvers approvers = new Approvers(Set.of("treasurer", "president"), true, false);
    static String me(Caller c) { return c.membership().toString(); }
    static Plan.Step step(String name, int needed, boolean canFinish, Plan.Approver... who) { return new Plan.Step("x", name, List.of(who), needed, canFinish, 0, false, List.of()); }
    static Policy rule(String name, int priority, List<String> subjects, String min, String max, String flag, Plan.Step... steps) {
        return new Policy(name, true, priority, subjects, min == null ? null : new BigDecimal(min), max == null ? null : new BigDecimal(max), List.of(), List.of(), flag, List.of(steps));
    }

    @Test void noRuleMeansTheCommitteeThenTheFinalApprovers() {
        Plan p = Policy.build(List.of(), new Policy.Context("Maintenance quotation", new BigDecimal("5000"), "MEP", "Purchase", List.of()), NOW);
        assertEquals(List.of("EC", "Final approval"), p.steps().stream().map(Plan.Step::name).toList());
        assertEquals(Plan.State.PENDING, p.position().state()); assertEquals(0, p.position().index());
        assertEquals("Pending", p.slots().ec()); assertNull(p.slots().finalRequired());
    }

    @Test void matchingRulesJoinInPriorityOrderAndTheSameApproversMerge() {
        Plan.Step ec = step("EC", 1, false, Plan.Approver.group(Plan.Group.EC_MEMBERS));
        Plan.Step ec2 = step("Two from EC", 2, false, Plan.Approver.group(Plan.Group.EC_MEMBERS));
        Plan.Step pres = step("President", 1, false, Plan.Approver.role("president"));
        List<Policy> rules = List.of(rule("big", 20, List.of("Maintenance quotation"), "50000", null, null, ec2, pres), rule("all", 10, List.of(), null, null, null, ec),
            rule("over", 5, List.of(), null, null, "overBudget", pres), rule("cultural", 1, List.of("Cultural expense"), null, null, null, pres));
        Plan small = Policy.build(rules, new Policy.Context("Maintenance quotation", new BigDecimal("10000"), null, null, List.of()), NOW);
        assertEquals(List.of("all"), small.rules()); assertEquals(1, small.steps().size());
        Plan big = Policy.build(rules, new Policy.Context("Maintenance quotation", new BigDecimal("75000"), null, null, List.of("overBudget")), NOW);
        assertEquals(List.of("over", "all", "big"), big.rules());
        assertEquals(List.of("President", "EC"), big.steps().stream().map(Plan.Step::name).toList(), "the president step merges; EC keeps the larger count");
        assertEquals(2, (int) big.steps().get(1).needed());
    }

    @Test void decisionsMoveThroughTheStepsAndTheSlotsFollow() {
        Plan p = Policy.build(List.of(), new Policy.Context("Maintenance invoice", BigDecimal.TEN, null, null, List.of()), NOW);
        assertNull(approvers.whyNot(p, secretary, null), "any EC member decides the EC step");
        assertNotNull(approvers.whyNot(p, fm, null), "staff do not");
        Plan a = p.decide(me(secretary), "Sec", NOW, "Approved", "ok", false);
        assertEquals("Approved", a.slots().ec()); assertEquals(Boolean.TRUE, a.slots().finalRequired()); assertEquals("Pending", a.slots().fin());
        assertTrue(approvers.whyNot(a, secretary, null).startsWith("Only Final approvers"), "the final step is the final approvers'");
        assertNull(approvers.whyNot(a, president, null));
        Plan b = a.decide(me(president), "Pres", NOW, "Approved", null, false);
        assertTrue(b.approved()); assertEquals("Approved", b.slots().fin()); assertEquals("Pres", b.slots().finLast().name());
        assertThrows(IllegalStateException.class, () -> b.decide(me(treasurer), "T", NOW, "Approved", null, false), "nothing is waiting");
        Plan undone = b.undo(me(president));
        assertEquals(Plan.State.PENDING, undone.position().state()); assertEquals(1, undone.position().index());
        assertThrows(IllegalStateException.class, () -> undone.undo(me(treasurer)), "only who decided can undo");
        Plan rejected = a.decide(me(president), "Pres", NOW, "Rejected", "too costly", false);
        assertTrue(rejected.rejected()); assertEquals("Rejected", rejected.slots().fin());
    }

    @Test void finishingEarlySkipsTheLaterSteps() {
        Plan p = new Plan(1, NOW.toString(), List.of(), BigDecimal.ONE, Policy.defaultSteps(), List.of());
        Plan done = p.decide(me(secretary), "Sec", NOW, "Approved", null, true);
        assertTrue(done.approved()); assertTrue(done.steps().get(1).skipped()); assertEquals(Boolean.FALSE, done.slots().finalRequired());
    }

    @Test void separateApproversAndOwnRequests() {
        Approvers sep = new Approvers(Set.of("treasurer"), true, true);
        Plan p = new Plan(1, NOW.toString(), List.of(), BigDecimal.ONE, Policy.defaultSteps(), List.of());
        assertEquals("You cannot approve your own request", sep.whyNot(p, treasurer, me(treasurer)));
        Plan a = p.decide(me(treasurer), "T", NOW, "Approved", null, false);
        assertTrue(sep.whyNot(a, treasurer, null).contains("another step"));
        assertNull(approvers.whyNot(a, treasurer, null), "allowed when the community does not keep them separate");
        assertTrue(new Approvers(Set.of("treasurer"), false, false).isEc(secretary));
        assertFalse(new Approvers(Set.of("treasurer"), false, false).isEc(treasurer), "a final approver does not decide the EC step unless allowed");
        assertTrue(new Approvers(Set.of(), false, false).eligible(p.steps().get(1), Fixtures.superAdmin()), "the super admin always may");
    }

    @Test void overrideKeepsDecidedSteps() {
        Plan p = new Plan(1, NOW.toString(), List.of(), BigDecimal.ONE, Policy.defaultSteps(), List.of()).decide(me(secretary), "Sec", NOW, "Approved", null, false);
        Plan o = p.override(List.of(step("President", 1, false, Plan.Approver.role("president"))), "the treasurer is away", me(secretary), NOW);
        assertEquals(List.of("EC", "President"), o.steps().stream().map(Plan.Step::name).toList());
        assertEquals(1, o.overrides().size());
        assertThrows(IllegalArgumentException.class, () -> p.override(List.of(), " ", "x", NOW));
    }

    @Test void plansRoundTripAndOldPlansStillRead() {
        PlanCodec codec = new PlanCodec(Json.mapper());
        Plan p = Policy.build(List.of(), new Policy.Context("Maintenance quotation", BigDecimal.TEN, null, null, List.of()), NOW).decide("m1", "Sec", NOW, "Approved", "ok", false);
        Plan back = codec.read(codec.write(p));
        assertEquals(p, back);
        String legacy = "{\"version\":1,\"built\":\"2026-09-01\",\"rules\":[],\"amount\":500,\"steps\":[{\"id\":\"s1\",\"name\":\"EC\",\"approvers\":[{\"kind\":\"group\",\"value\":\"EC members\"}],"
            + "\"needed\":1,\"canFinish\":true,\"deadlineDays\":0,\"decisions\":[{\"by\":\"Asha\",\"at\":\"2026-09-02\",\"value\":\"Approved\",\"comment\":\"\"}]}],\"overrides\":[],\"extra\":true}";
        Plan old = codec.read(legacy);
        assertTrue(old.approved()); assertEquals(Instant.parse("2026-09-02T00:00:00Z"), old.slots().ecLast().instant());
        assertThrows(IllegalStateException.class, () -> codec.read("{not json"), "a plan that cannot be read is an error, not an empty plan");
    }

    @Test void documentAmounts() {
        Quotation.Amounts extra = Quotation.Amounts.of(new BigDecimal("10000"), "Extra", new BigDecimal("18"));
        assertEquals("1800.00", extra.gst().amount().toPlainString()); assertEquals("11800.00", extra.total().amount().toPlainString());
        Quotation.Amounts incl = Quotation.Amounts.of(new BigDecimal("11800"), "Included", new BigDecimal("18"));
        assertEquals("10000.00", incl.base().amount().toPlainString()); assertEquals("1800.00", incl.gst().amount().toPlainString());
        assertEquals("500.00", Quotation.Amounts.of(new BigDecimal("500"), null, null).total().amount().toPlainString());
        assertThrows(DomainException.RuleViolated.class, () -> Quotation.Amounts.of(new BigDecimal("5"), "Half", null));
        assertThrows(DomainException.RuleViolated.class, () -> Quotation.Amounts.of(new BigDecimal("5"), "Extra", new BigDecimal("50")));
    }
}
