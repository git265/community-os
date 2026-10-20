package com.communityos.notify;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.TextNode;
import java.util.ArrayList;
import java.util.List;

/**
 * Where a task's quotation, or an invoice, is in its approval chain, and which roles give the final approval. A port of approvalState / approvalSteps /
 * invoiceApproval / finalApproverRoleIds in src/modules/tickets/ticketEngine.js (only what the messages need).
 */
public final class TicketApprovals {
    private TicketApprovals() {}

    /** @param waitingOn "ec", "treasurer" / "final", or null */
    public record State(String key, String label, String waitingOn) {}

    private static boolean eq(JsonNode n, String v) { return Js.strictEq(n, TextNode.valueOf(v)); }

    /** The task-level chain approves the selected QUOTATION. waitingOn is "ec", "treasurer" or null. */
    public static State approvalState(JsonNode ticket, JsonNode type) {
        if (ticket == null || ticket.isNull() || ticket.isMissingNode() || !Js.truthy(ticket, "selectedQuotationId")) return new State("none", "", null);
        boolean fin = Js.truthy(ticket, "financial");
        boolean ecRequired = eq(Js.f(type, "ecApprovalStage"), "Yes") || fin;
        boolean trRequired = eq(Js.f(type, "treasurerStage"), "Yes") || fin;
        if (Js.is(ticket, "ecApproval", "Rejected")) return new State("rejected", "Rejected by EC", null);
        if (Js.is(ticket, "treasurerApproval", "Rejected")) return new State("rejected", "Rejected at final approval", null);
        boolean live = !Js.is(ticket, "status", "Closed") && !Js.is(ticket, "status", "Cancelled");
        boolean ecOk = Js.is(ticket, "ecApproval", "Approved"), trOk = Js.is(ticket, "treasurerApproval", "Approved");
        if (ecRequired && !ecOk) return new State("pending-ec", "Awaiting EC", live ? "ec" : null);
        if (ecOk && Js.f(ticket, "finalRequired").isBoolean() && !Js.f(ticket, "finalRequired").asBoolean()) return new State("approved", "Approved by EC (last step)", null);
        if (trRequired && !trOk) return new State("pending-treasurer", "Awaiting final approval", live ? "treasurer" : null);
        if (ecOk || trOk) return new State("approved", "Approved", null);
        return new State("none", "", null);
    }

    /** One invoice's approval: EC first, then a final approver. */
    public static State invoiceApproval(JsonNode doc) {
        if (doc == null || doc.isNull() || doc.isMissingNode() || !Js.truthy(doc)) return new State("none", "", null);
        if (Js.f(doc, "selected").isBoolean() && !Js.f(doc, "selected").asBoolean()) return new State("unselected", "Not selected", null);
        if (Js.truthy(doc, "approvalWaived")) return new State("approved", "Pre-approved (within quotation)", null);
        if (Js.is(doc, "ecApproval", "Rejected")) return new State("rejected", "Rejected by EC", null);
        if (Js.is(doc, "finalApproval", "Rejected")) return new State("rejected", "Rejected at final approval", null);
        if (!Js.is(doc, "ecApproval", "Approved")) return new State("pending-ec", "Awaiting EC", "ec");
        if (Js.f(doc, "finalRequired").isBoolean() && !Js.f(doc, "finalRequired").asBoolean()) return new State("approved", "Approved by EC (last step)", null);
        if (!Js.is(doc, "finalApproval", "Approved")) return new State("pending-final", "Awaiting final approval", "final");
        return new State("approved", "Approved", null);
    }

    /** Roles set as final approvers (Treasurer and President until the setting exists). */
    public static List<JsonNode> finalApproverRoleIds(List<JsonNode> approverSettings) {
        JsonNode r = approverSettings.isEmpty() ? Js.MISSING : Js.f(approverSettings.get(0), "roles");
        List<JsonNode> out = new ArrayList<>();
        if (r.isArray() && r.size() > 0) r.forEach(out::add);
        else { out.add(JsonNodeFactory.instance.textNode("treasurer")); out.add(JsonNodeFactory.instance.textNode("president")); }
        return out;
    }
}
