package com.communityos.security;

import static com.communityos.security.Changes.changedKeys;
import static com.communityos.security.Changes.isResetValue;
import static com.communityos.security.Perms.anyPerm;
import static com.communityos.security.Perms.isAdmin;
import static com.communityos.security.Perms.isEC;
import static com.communityos.security.Perms.isQuoteRole;
import static com.communityos.security.Perms.isSecondApprover;
import static com.communityos.security.Verdict.OK;
import static com.communityos.security.Verdict.deny;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** Write rules for money: the ledger, invoices and quotations, fund releases, event expenses, and who may set the approvers. */
final class FinanceRules {
    private FinanceRules() {}

    /** Payments Cross-check: ledger managers. One exception: a final approver crediting an event's unused budget leaves an internal record. */
    static Verdict ledger(WriteCall c) {
        if (anyPerm(c.p(), "MANAGE_LEDGER")) return null;   // normal field checks follow
        JsonNode next = c.next();
        if (c.old() == null && Js.is(next, "sourceType", "culturalCredit") && Js.f(next, "internal").isBoolean() && Js.f(next, "internal").asBoolean() && isSecondApprover(c.p(), c.ctx())) return OK;
        return deny("Requires permission: MANAGE_LEDGER");
    }

    static Verdict approverSettings(WriteCall c) {
        return Perms.SETTINGS_EDITORS.contains(c.p().roleId()) ? OK : deny("Only the President or the Treasurer can change who gives the final approval");
    }

    static Verdict quotations(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next(); RuleContext ctx = c.ctx();
        if (!isQuoteRole(p)) return deny("Only the EC, Facility Manager or MEP can manage quotations");
        if (!Js.is(next, "kind", "Invoice") && !Js.is(old, "kind", "Invoice")) return OK;
        // Invoices: each one is approved on its own - EC first, then a final approver. Nobody records an approval at creation.
        List<String> ch = changedKeys(old, next);
        if (old == null && (!isResetValue(Js.f(next, "ecApproval")) || !isResetValue(Js.f(next, "finalApproval")))) return deny("A new invoice always starts with approvals Pending");
        if (old != null && ch.contains("approvalWaived")) return deny("Whether an invoice needs approval is fixed when it is uploaded");
        if (old == null) return OK;
        boolean resets = isResetValue(Js.f(next, "ecApproval")) && isResetValue(Js.f(next, "finalApproval"));
        // Correction: the EC (or Super Admin) sends an approved invoice back with a reason - approvals return to Pending.
        if (!Js.strictEq(Js.f(old, "correctionNote"), Js.f(next, "correctionNote")) && !Changes.orEmpty(next, "correctionNote").trim().isEmpty() && resets) {
            return isEC(p) || isAdmin(p) ? OK : deny("Only the EC can send an approved invoice back for correction");
        }
        Verdict pc = PlanRules.planChange(p, old, next, "doc", ctx);
        if (pc != null && !pc.ok()) return pc;
        if (pc == null && ch.stream().anyMatch(List.of("ecApproval", "ecApprovedBy", "ecApprovedAt", "finalRequired")::contains) && !isEC(p)) return deny("Only EC members can record the EC approval");
        if (pc == null && ch.stream().anyMatch(List.of("finalApproval", "finalApprovedBy", "finalApprovedAt")::contains) && !isSecondApprover(p, ctx)) return deny("Only the roles set as final approvers (Maintenance → Final approvers) can record the final approval");
        if (ch.contains("selected") && Js.f(next, "selected").isBoolean() && !Js.f(next, "selected").asBoolean() && !resets) return deny("Unselecting an invoice restarts its approval - clear the EC and final approval together with it");
        if (ch.stream().anyMatch(List.of("amount", "baseAmount", "gstAmount", "gstRate", "gstMode", "vendor")::contains) && (Js.is(old, "ecApproval", "Approved") || Js.is(old, "finalApproval", "Approved"))) return deny("An approved invoice cannot be edited");
        JsonNode ecNext = Js.f(next, "ecApproval"); boolean ecNullish = ecNext.isMissingNode() || ecNext.isNull();
        JsonNode ecEffective = ecNullish ? Js.f(old, "ecApproval") : ecNext;
        if (Js.is(next, "finalApproval", "Approved") && !Js.is(old, "finalApproval", "Approved") && !(ecEffective.isTextual() && ecEffective.asText().equals("Approved"))) return deny("Final approval needs the EC approval first");
        return OK;
    }

    /** Fund releases against an approved task amount: raised by the EC / coordinators, approved through the plan, paid by the accounting roles. */
    static Verdict releases(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        boolean cultural = Js.truthy(next, "expenseId") || Js.truthy(old, "expenseId");
        if (!(isQuoteRole(p) || anyPerm(p, "MANAGE_LEDGER") || (cultural && anyPerm(p, "MANAGE_CULTURAL")))) {
            return deny(cultural ? "Only the EC, cultural managers or accounting roles can handle cultural releases" : "Only the EC, Facility Manager or accounting roles can handle releases");
        }
        if (c.isDelete()) return Js.is(old, "status", "Waiting approval") || Js.is(old, "status", "Rejected") ? OK : deny("An approved or paid release cannot be deleted");
        if (old == null) {
            JsonNode plan = ApprovalEngine.parsePlan(Js.f(next, "plan"));
            boolean anyDecision = plan != null && Js.list(plan, "steps").stream().anyMatch((s) -> !Js.list(s, "decisions").isEmpty());
            return Js.is(next, "status", "Waiting approval") && !anyDecision ? OK : deny("A new release always starts as Waiting approval");
        }
        Verdict pc = PlanRules.planChange(p, old, next, "expense", c.ctx());
        if (pc != null && !pc.ok()) return pc;
        if (!Js.strictEq(Js.f(next, "status"), Js.f(old, "status"))) {
            if (Js.is(old, "status", "Waiting approval")) {
                String st = ApprovalEngine.planState(ApprovalEngine.parsePlan(Js.f(next, "plan"))).key();
                String want = st.equals("approved") ? "Approved" : st.equals("rejected") ? "Rejected" : "Waiting approval";
                return pc != null && Js.is(next, "status", want) ? OK : deny("The status must follow the approval steps");
            }
            if (Js.is(old, "status", "Approved") && Js.is(next, "status", "Paid")) return isEC(p) || anyPerm(p, "MANAGE_LEDGER") ? OK : deny("Only the accounting roles can mark a release as paid");
            if (Js.is(old, "status", "Rejected") && Js.is(next, "status", "Waiting approval")) return OK;
            // correction: an unpaid release is cancelled with a reason (EC or accounting); a Paid one goes back to Approved only after its payment is reversed
            if (Js.is(next, "status", "Cancelled") && (Js.is(old, "status", "Waiting approval") || Js.is(old, "status", "Approved"))) {
                return isEC(p) || isAdmin(p) || anyPerm(p, "MANAGE_LEDGER") ? OK : deny("Only the EC or accounting roles can cancel a release");
            }
            if (Js.is(old, "status", "Paid") && Js.is(next, "status", "Approved")) return anyPerm(p, "MANAGE_LEDGER") || isAdmin(p) ? OK : deny("Only accounting roles can reopen a paid release");
            return deny("Invalid release status change");
        }
        if (pc != null && Js.is(old, "status", "Waiting approval")) return OK;
        if (!Js.is(old, "status", "Waiting approval") && changedKeys(old, next).stream().anyMatch(List.of("amount", "kind", "vendor")::contains)) return deny("A decided release cannot be changed");
        return OK;
    }

    /** Event expenses go through the same two steps as a task: an EC member approves first, then (when needed) a final approver. */
    static Verdict culturalExpenses(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        boolean approver = isSecondApprover(p, c.ctx());
        boolean ec = isEC(p) || isAdmin(p);
        List<String> ecKeys = List.of("ecApproval", "ecApprovedBy", "ecApprovedAt", "ecNote");
        if (c.isDelete()) return approver || Js.is(old, "status", "Pending approval") || Js.is(old, "status", "Rejected") ? OK : deny("An approved expense cannot be deleted - ask the Treasurer");
        if (old == null) return Js.is(next, "status", "Pending approval") && !Js.truthy(next, "approvedBy") && isResetValue(Js.f(next, "ecApproval")) ? OK : deny("A new expense always starts as Pending approval");
        Verdict pc = PlanRules.planChange(p, old, next, "expense", c.ctx());
        if (pc != null && !pc.ok()) return pc;
        if (pc != null) {
            if (!Js.is(old, "status", "Pending approval")) return deny("This expense is already decided");
            String st = ApprovalEngine.planState(ApprovalEngine.parsePlan(Js.f(next, "plan"))).key();
            String want = st.equals("approved") ? "Approved" : st.equals("rejected") ? "Rejected" : "Pending approval";
            return Js.is(next, "status", want) ? OK : deny("The status must match the approval steps");
        }
        List<String> ch = changedKeys(old, next);
        boolean ecCh = ch.stream().anyMatch(ecKeys::contains);
        boolean decision = ch.stream().anyMatch(List.of("status", "approvedBy", "approvedAt", "approvalNote")::contains);
        boolean resubmit = Js.is(old, "status", "Rejected") && Js.is(next, "status", "Pending approval") && !Js.truthy(next, "approvedBy") && isResetValue(Js.f(next, "ecApproval"));
        if (resubmit) return OK;
        String ecState = Js.truthy(old, "ecApproval") ? Js.str(old, "ecApproval") : "Pending";
        if (ecCh) {
            if (!ec) return deny("Only EC members can record the EC approval");
            if (!isAdmin(p) && Js.truthy(old, "recordCreatedBy") && Js.str(old, "recordCreatedBy").equals(p.name())) return deny("Another EC member must approve an expense you raised");
            if (!Js.is(old, "status", "Pending approval") || !ecState.equals("Pending")) return deny("The EC step of this expense is already decided");
        }
        if (decision) {
            String to = Js.text(next, "status");
            if ("Paid".equals(to)) {
                if (!approver || !Js.is(old, "status", "Approved")) return deny("Only a final approver can mark an Approved expense as paid");
                return OK;
            }
            if (!Js.is(old, "status", "Pending approval")) return deny("This expense is already decided");
            boolean ecStepNow = ecCh && !Js.is(next, "ecApproval", "Pending");
            if ("Rejected".equals(to)) return ecStepNow || (approver && ecState.equals("Approved")) ? OK : deny("Reject it at your own step: EC first, then the final approver");
            if ("Approved".equals(to)) {
                if (approver && ecState.equals("Approved")) return OK;
                if (ecStepNow && Js.is(next, "ecApproval", "Approved") && Js.f(next, "finalRequired").isBoolean() && !Js.f(next, "finalRequired").asBoolean()) return OK;
                return deny(ecState.equals("Approved") ? "Only the Treasurer or President (final approvers) can give the final approval" : "The EC must approve this expense first");
            }
            return deny("Invalid expense decision");
        }
        if (Js.is(old, "status", "Pending approval") && ecCh && Js.is(next, "ecApproval", "Approved")) return OK;   // EC approved, now waits for the final approver
        if ((!Js.is(old, "status", "Pending approval") || ecState.equals("Approved")) && !Js.is(old, "status", "Rejected")
                && ch.stream().anyMatch(List.of("item", "category", "vendor", "amount", "date", "fund", "eventId", "finalRequired")::contains)) {
            return deny("This expense is already under final approval or decided - ask the approver to send it back for changes");
        }
        return OK;
    }
}
