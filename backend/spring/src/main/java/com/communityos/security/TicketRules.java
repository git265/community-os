package com.communityos.security;

import static com.communityos.security.Changes.changedKeys;
import static com.communityos.security.Changes.forbidKeys;
import static com.communityos.security.Changes.isResetValue;
import static com.communityos.security.Changes.onlyKeys;
import static com.communityos.security.Perms.anyPerm;
import static com.communityos.security.Perms.canManageReadings;
import static com.communityos.security.Perms.has;
import static com.communityos.security.Perms.isAdmin;
import static com.communityos.security.Perms.isEC;
import static com.communityos.security.Perms.isHandyman;
import static com.communityos.security.Perms.isQuoteRole;
import static com.communityos.security.Perms.isResident;
import static com.communityos.security.Perms.isSecondApprover;
import static com.communityos.security.Perms.isStaff;
import static com.communityos.security.Verdict.OK;
import static com.communityos.security.Verdict.deny;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Write rules for tasks / tickets, their comments, bills (dues) and meter readings. */
final class TicketRules {
    private TicketRules() {}

    private static final List<String> TICKET_CREATORS_STAFF = List.of("facility_manager", "handyman_mep");
    static final List<String> FIN_FIELDS = List.of("financial", "selectedQuotationId", "selectedQuotationIds", "selectedInvoiceId", "approvalStage", "approvedAmount", "invoiceApprovalMode",
            "quotationStatus", "invoiceStatus", "paymentStatus", "ecApproval", "ecApprovedBy", "ecApprovedAt", "finalRequired", "treasurerApproval", "treasurerApprovedBy", "treasurerApprovedAt");
    private static final List<String> EC_APPROVAL_FIELDS = List.of("ecApproval", "ecApprovedBy", "ecApprovedAt", "finalRequired");
    private static final List<String> TREASURER_APPROVAL_FIELDS = List.of("treasurerApproval", "treasurerApprovedBy", "treasurerApprovedAt");
    /** Status values that mean "an EC member signed this off": only EC members may pick them. */
    private static final Map<String, List<String>> EC_ONLY_STATUS = Map.of("quotationStatus", List.of("EC Approved", "Treasurer Approved"), "invoiceStatus", List.of("EC Approved", "Treasurer Approved"));

    private static boolean sameUnit(JsonNode rec, String unit) { String u = Js.text(rec, "unit"); return u != null && u.equals(unit); }

    /** SLA due: a future date when set; once the task exists only EC members may change it. */
    static Verdict slaGuard(Principal p, JsonNode old, JsonNode next, RuleContext ctx) {
        String now = Changes.orEmpty(next, "slaDueAt"); String was = Changes.orEmpty(old, "slaDueAt");
        if (now.equals(was)) return OK;
        if (old != null && !isEC(p)) return deny("Only EC members can change the SLA due date once the task is created");
        if (Js.truthy(next, "slaDueAt")) {
            String v = Js.str(next, "slaDueAt");
            if (!(v.matches("^\\d{4}-\\d{2}-\\d{2}$") && v.compareTo(ctx.today()) >= 0)) return deny("SLA due must be today or a future date");
        }
        return OK;
    }

    static Verdict financeGuard(Principal p, JsonNode old, JsonNode next, RuleContext ctx) {
        for (String field : List.of("quotationStatus", "invoiceStatus")) {
            JsonNode now = Js.f(next, field);
            if (!Js.strictEq(now, Js.f(old, field)) && now.isTextual() && EC_ONLY_STATUS.get(field).contains(now.asText()) && !isEC(p)) {
                return deny("Only EC members can set " + (field.equals("quotationStatus") ? "Quotation" : "Invoice") + " status to \"" + now.asText() + "\"");
            }
        }
        // The "involves a financial transaction" checkbox: only roles holding SET_FINANCIAL_FLAG (default EC + Super Admin).
        if (old != null && Js.truthy(next, "financial") != Js.truthy(old, "financial")) {
            if (!(isAdmin(p) || anyPerm(p, "SET_FINANCIAL_FLAG"))) return deny("Only the EC and Super Admin (or roles given the permission) can change whether a task involves a financial transaction");
        }
        List<String> changed = changedKeys(old, next);
        // Uploading a new quotation / invoice restarts the chain: the Facility Manager / MEP may put the approvals back to Pending, never record one.
        java.util.function.Predicate<List<String>> isReset = (keys) -> isQuoteRole(p) && keys.stream().allMatch((k) -> isResetValue(Js.f(next, k)));
        List<String> ecKeys = changed.stream().filter(EC_APPROVAL_FIELDS::contains).toList();
        List<String> trKeys = changed.stream().filter(TREASURER_APPROVAL_FIELDS::contains).toList();
        Verdict pc = PlanRules.planChange(p, old, next, "ticket", ctx);
        if (pc != null && !pc.ok()) return pc;
        if (pc != null) return OK;
        if (!ecKeys.isEmpty() && !isEC(p) && !isReset.test(ecKeys)) return deny("Only EC members can record the EC approval");
        if (!trKeys.isEmpty() && !isSecondApprover(p, ctx) && !isReset.test(trKeys)) return deny("Only the roles set as final approvers (Maintenance → Final approvers) can record the final approval");
        return OK;
    }

    static Verdict tickets(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (c.isDelete()) return deny("Tickets cannot be deleted - cancel or close them instead");
        if (isResident(p)) {
            if (p.unit().isEmpty()) return deny("Residents can only act on tickets for their own unit");
            if (old != null && Js.is(old, "scope", "Community") && !sameUnit(old, p.unit())) {
                // someone else's community request: the only thing a resident may do is add / remove their own "me too"
                if (changedKeys(old, next).stream().anyMatch((k) -> !k.equals("affectedUnits"))) return deny("You can only add your villa to this community request (\"Me too\")");
                List<String> a = Js.strings(old, "affectedUnits"); List<String> b = Js.strings(next, "affectedUnits");
                List<String> diff = new ArrayList<>();
                a.stream().filter((u) -> !b.contains(u)).forEach(diff::add);
                b.stream().filter((u) -> !a.contains(u)).forEach(diff::add);
                return diff.stream().allMatch((u) -> u.equals(p.unit())) ? OK : deny("You can only add or remove your own villa");
            }
            if (!sameUnit(next, p.unit())) return deny("Residents can only act on tickets for their own unit");
            if (old == null) {
                if (Js.is(next, "scope", "Community") && Js.str(next, "location").trim().isEmpty()) return deny("Say where in the community the problem is");
                if (Js.truthy(next, "createdByRole") && !Js.str(next, "createdByRole").equals(p.roleId())) return deny("Ticket creator mismatch");
                return R77Rules.residentTicketCreate(c);
            }
            Verdict base = onlyKeys(old, next, List.of("description", "attachments", "photos", "hasPhotos", "preferredTime", "residentRating", "status", "cancelledAt", "cancelledBy", "affectedUnits", "location"), "Residents");
            if (!base.ok()) return base;
            if (!Js.strictEq(Js.f(next, "status"), Js.f(old, "status"))) {
                // the owner confirms finished work: Completed -> Closed
                if (Js.is(next, "status", "Closed") && Js.is(old, "status", "Completed")) return OK;
                if (!Js.is(next, "status", "Cancelled")) return deny("Residents can only Cancel a ticket, or Close it once the team marks it Completed");
                if (Js.is(old, "status", "Closed") || Js.is(old, "status", "Cancelled")) return deny("This ticket is already finished");
            }
            return OK;
        }
        if (old == null && isStaff(p) && !TICKET_CREATORS_STAFF.contains(p.roleId())) return deny("Only the Facility Manager and MEP can create tasks");
        boolean statusChanged = old != null && !Js.strictEq(Js.f(next, "status"), Js.f(old, "status"));
        if (old != null && (Js.is(old, "status", "Closed") || Js.is(old, "status", "Cancelled")) && statusChanged && !isEC(p)) return deny("Only EC members can reopen a closed ticket");
        // Close / Cancel: only the ticket owner (Closed once Completed), EC members, or a final approver. The assignee as such cannot close or cancel.
        if (statusChanged && (Js.is(next, "status", "Closed") || Js.is(next, "status", "Cancelled")) && !isEC(p) && !isAdmin(p)) {
            boolean owner = (Js.text(old, "createdBy") != null && Js.text(old, "createdBy").equals(p.name())) || (Js.text(old, "createdByRole") != null && Js.text(old, "createdByRole").equals(p.roleId()));
            boolean okClose = Js.is(next, "status", "Closed") && ((owner && Js.is(old, "status", "Completed")) || isSecondApprover(p, c.ctx()));
            boolean okCancel = Js.is(next, "status", "Cancelled") && owner;
            if (!okClose && !okCancel) return deny("Only the ticket owner, an EC member or the final approver can close or cancel a ticket - not the assignee");
        }
        Verdict sla = slaGuard(p, old, next, c.ctx());
        if (!sla.ok()) return sla;
        Verdict fin = financeGuard(p, old, next, c.ctx());
        if (!fin.ok()) return fin;
        if ("handyman_mep".equals(p.roleId())) {
            // MEP coordinates the contract with the Facility Manager: full working access except identity fields.
            return old != null ? forbidKeys(old, next, List.of("taskType", "unit", "createdBy", "createdByRole", "ticketNumber", "residentRating"), "MEP") : OK;
        }
        if (isHandyman(p)) {
            if (old == null) return OK;
            List<String> forbidden = new ArrayList<>(List.of("taskType", "unit", "category", "priority"));
            FIN_FIELDS.stream().filter((k) -> !k.equals("materialsCost")).forEach(forbidden::add);
            forbidden.addAll(List.of("residentRating", "createdBy", "createdByRole", "ticketNumber"));
            return forbidKeys(old, next, forbidden, "Field staff");
        }
        return null;   // EC / Facility Manager -> the schema's field rules
    }

    static Verdict comments(WriteCall c) {
        if (c.isDelete() || c.old() != null) return has(c.p(), "MANAGE_TICKETS") ? OK : deny("Comments cannot be edited or deleted");
        if (isResident(c.p()) && Js.is(c.next(), "visibility", "Internal")) return deny("Residents cannot post internal comments");
        return OK;
    }

    /** Bills: finance roles manage them freely; meter-reading roles can only create the Water / DG bill when they publish a reading. */
    static Verdict dues(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        // An owner can pay their own unit's bill - and change nothing else on it.
        if (isResident(p)) {
            if (c.isDelete() || old == null) return deny("Requires permission: MANAGE_DUES or MANAGE_UTILITY_BILLING");
            if (p.unit().isEmpty() || !sameUnit(old, p.unit())) return deny("You can only pay your own unit's dues");
            if (Js.is(old, "status", "Paid")) return deny("This bill is already paid");
            if (Js.is(old, "status", "Cancelled")) return deny("This bill was cancelled");
            if (!Js.is(next, "status", "Paid")) return deny("Residents can only mark a bill as paid");
            return onlyKeys(old, next, List.of("status", "paymentMode", "paymentRef", "paidAt", "paidBy", "receiptNo"), "Residents");
        }
        if (anyPerm(p, "MANAGE_DUES", "MANAGE_UTILITY_BILLING")) return null;
        if (canManageReadings(p)) {
            String category = Js.text(next, "category");
            return old == null && !c.isDelete() && category != null && c.ctx().utilityNames().contains(category) && Js.truthy(next, "readingId")
                    ? OK : deny("Meter-reading roles can only publish a Water / DG bill - other dues need Manage dues");
        }
        return deny("Requires permission: MANAGE_DUES or MANAGE_UTILITY_BILLING");
    }

    static Verdict readings(WriteCall c) {
        if (!canManageReadings(c.p())) return deny("Requires permission: MANAGE_UTILITY_READINGS");
        if (c.isDelete()) return Js.is(c.old(), "status", "Published") ? deny("A published reading cannot be deleted") : OK;
        if (Js.is(c.old(), "status", "Published")) return deny("This reading is already published to the owner and is locked");
        return OK;
    }
}
