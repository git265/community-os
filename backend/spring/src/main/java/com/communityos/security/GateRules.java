package com.communityos.security;

import static com.communityos.security.Changes.changedKeys;
import static com.communityos.security.Changes.keysOf;
import static com.communityos.security.Changes.onlyKeys;
import static com.communityos.security.Perms.gateOrFM;
import static com.communityos.security.Perms.gateStaff;
import static com.communityos.security.Perms.isEC;
import static com.communityos.security.Perms.isResident;
import static com.communityos.security.Verdict.OK;
import static com.communityos.security.Verdict.deny;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** Write rules for GateGuard: visitors, passes, household staff, approvals, vetting. */
final class GateRules {
    private GateRules() {}

    private static boolean unitIs(JsonNode r, String unit) { String u = Js.text(r, "unit"); return u != null && u.equals(unit); }
    private static final List<String> VETTED = List.of("Active", "Under review", "Suspended", "Blocked");

    static Rule onlyGateStaff(String message) { return (c) -> gateStaff(c.p()) ? null : deny(message); }

    static Verdict passTemplates(WriteCall c) {
        Principal p = c.p();
        if (gateStaff(p)) return OK;
        JsonNode rec = c.next() != null ? c.next() : c.old();   // (next || old)?.unit
        return isResident(p) && !p.unit().isEmpty() && unitIs(rec, p.unit()) && (c.old() == null || unitIs(c.old(), p.unit())) ? OK : deny("A villa keeps only its own pass templates");
    }

    static Verdict settings(WriteCall c) {
        Principal p = c.p();
        return isEC(p) || "facility_manager".equals(p.roleId()) || (p.role() != null && "facility_manager".equals(p.role().id())) ? null : deny("Only the committee or Facility Manager set the gate rules");
    }

    static Verdict workOrders(WriteCall c) { return gateOrFM(c.p()) ? null : deny("Only the security team or Facility Manager manage crew work orders"); }

    /** The vetted registry: staff run the vetting; a resident may only INVITE someone for their own household (no checks, no status). */
    static Verdict people(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (gateOrFM(p)) return null;
        if (!isResident(p) || p.unit().isEmpty()) return deny("Only the security team vets people for the gate");
        if (c.isDelete()) return old != null && Js.is(old, "invitedByUnit", p.unit()) && (Js.is(old, "status", "Invited") || Js.is(old, "status", "Documents pending")) ? OK : deny("You can only withdraw your own invitation before vetting starts");
        if (VETTED.contains(Js.text(next, "status"))) return deny("Only the security team can vet or change the status");
        if (old != null && (!Js.is(old, "invitedByUnit", p.unit()) || VETTED.contains(Js.text(old, "status")))) return deny("This person is already with the security team");
        List<String> keys = old != null ? changedKeys(old, next) : keysOf(next);
        List<String> checks = List.of("idChecked", "addressChecked", "policeVerified", "policeExpiry", "referenceChecked", "faceEnrolled", "reviewNote", "statusReason");
        if (keys.stream().anyMatch((k) -> checks.contains(k) && Js.truthy(next, k))) return deny("Vetting checks are ticked by the security team");
        return Js.is(next, "invitedByUnit", p.unit()) ? OK : deny("Invite people for your own villa");
    }

    static Verdict passes(WriteCall c) {
        Principal p = c.p();
        if (gateStaff(p)) return OK;
        return ownVilla(c, "A villa manages only its own guest passes");
    }
    static Verdict links(WriteCall c) { return gateOrFM(c.p()) ? null : ownVilla(c, "A villa manages only its own household staff"); }
    static Verdict villaRules(WriteCall c) { return gateStaff(c.p()) ? null : ownVilla(c, "A villa sets only its own gate rules"); }

    private static Verdict ownVilla(WriteCall c, String message) {
        Principal p = c.p();
        JsonNode rec = c.old() != null ? c.old() : c.next();   // (old || next)?.unit
        return isResident(p) && !p.unit().isEmpty() && unitIs(rec, p.unit()) && (c.old() == null || unitIs(c.next(), p.unit())) ? OK : deny(message);
    }

    /** An approval is asked by the gate and ANSWERED by the villa (or, for an unlisted worker, by the Facility Manager). */
    static Verdict approvals(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (gateOrFM(p) && !isResident(p)) return OK;
        if (!isResident(p) || old == null || c.isDelete()) return deny("Only the gate asks for an approval");
        if (!unitIs(old, p.unit())) return deny("This approval is for another villa");
        Verdict only = onlyKeys(old, next, List.of("status", "answeredAt", "answeredBy", "alwaysAllow"), "A resident");
        if (!only.ok()) return only;
        String to = Js.text(next, "status");
        return ("Approved".equals(to) || "Denied".equals(to)) && (Js.is(old, "status", "Pending") || Js.is(old, "status", "No answer")) ? OK : deny("Answer with Approve or Deny");
    }
}
