package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

/**
 * The approval engine's read side (src/lib/approval/engine.js): a record's `plan` holds steps and the decisions on them; these pure functions say
 * what state it is in and who may act. Only what the authorization rules need is here; building plans from policies stays in the web app.
 */
public final class ApprovalEngine {
    private ApprovalEngine() {}
    private static final ObjectMapper JSON = new ObjectMapper();

    /** state of a plan: key is "none", "pending", "approved" or "rejected"; index and step say which step is waiting (or rejected). */
    public record PlanState(String key, int index, JsonNode step) {}

    /** The caller's "who counts as EC / final approver / admin" answers (they depend on the community's settings). */
    public record Helpers(Predicate<Principal> isEC, Predicate<Principal> isFinal, Predicate<Principal> isAdmin) {}

    /** `parsePlan`: the plan is stored as JSON text (or already an object); null when absent or not valid. */
    public static JsonNode parsePlan(JsonNode v) {
        if (v == null || v.isMissingNode() || v.isNull()) return null;
        if (v.isObject()) return v;
        if (v.isTextual()) {
            String s = v.asText();
            if (s.isEmpty()) return null;
            try { JsonNode n = JSON.readTree(s); return n == null || n.isNull() ? null : n; } catch (Exception e) { return null; }
        }
        return null;
    }

    public static String stepState(JsonNode step) {
        if (Js.truthy(step, "skipped")) return "skipped";
        List<JsonNode> ds = Js.list(step, "decisions");
        if (ds.stream().anyMatch((d) -> Js.is(d, "value", "Rejected"))) return "rejected";
        Set<String> ok = new HashSet<>();
        for (JsonNode d : ds) if (Js.is(d, "value", "Approved")) ok.add(Js.str(d, "by"));
        double needed = Js.number(step, "needed");
        return ok.size() >= (needed == 0 ? 1 : needed) ? "approved" : "pending";
    }

    public static PlanState planState(JsonNode plan) {
        JsonNode steps = Js.f(plan, "steps");
        if (!steps.isArray() || steps.size() == 0) return new PlanState("none", -1, null);
        for (int i = 0; i < steps.size(); i++) {
            String s = stepState(steps.get(i));
            if (s.equals("rejected")) return new PlanState("rejected", i, steps.get(i));
            if (s.equals("pending")) return new PlanState("pending", i, steps.get(i));
        }
        return new PlanState("approved", steps.size(), null);
    }

    public static boolean approverMatches(JsonNode a, Principal p, Helpers h) {
        if (p == null) return false;
        String kind = Js.text(a, "kind"); String value = Js.text(a, "value");
        if ("group".equals(kind)) return "EC members".equals(value) ? h.isEC().test(p) : "Final approvers".equals(value) && h.isFinal().test(p);
        if ("role".equals(kind)) return value != null && (value.equals(p.roleId()) || p.extraRoleIds().contains(value));
        if ("user".equals(kind)) return value != null && value.equals(p.name());
        return false;
    }

    public static boolean stepEligible(JsonNode step, Principal p, Helpers h) {
        if (step == null) return false;
        if (h.isAdmin().test(p)) return true;
        for (JsonNode a : Js.list(step, "approvers")) if (approverMatches(a, p, h)) return true;
        return false;
    }

    /** The two-slot fields the rest of the app reads, derived from the plan: step 1 is the "EC" slot, every later live step together the "final" slot. */
    public static Map<String, Object> legacy(JsonNode plan, String shape) {
        List<JsonNode> steps = Js.list(plan, "steps");
        JsonNode first = steps.get(0);
        List<JsonNode> rest = new ArrayList<>(steps.subList(1, steps.size()));
        String f = stepState(first);
        List<JsonNode> live = rest.stream().filter((s) -> !Js.truthy(s, "skipped")).toList();
        JsonNode ecL = lastOf(List.of(first));
        String ec = f.equals("approved") ? "Approved" : f.equals("rejected") ? "Rejected" : "Pending";
        List<String> states = live.stream().map(ApprovalEngine::stepState).toList();
        String fin = live.isEmpty() ? "Pending" : states.contains("rejected") ? "Rejected" : states.stream().allMatch("approved"::equals) ? "Approved" : "Pending";
        JsonNode finL = lastOf(live);
        Boolean finalRequired = !ec.equals("Approved") ? null : !live.isEmpty();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ecApproval", ec);
        out.put("ecApprovedBy", ec.equals("Pending") ? "" : ecL == null ? "" : Js.str(ecL, "by"));
        out.put("ecApprovedAt", ec.equals("Pending") ? "" : ecL == null ? "" : Js.str(ecL, "at"));
        out.put("finalRequired", finalRequired);
        if ("expense".equals(shape)) return out;
        String by = fin.equals("Pending") ? "" : finL == null ? "" : Js.str(finL, "by");
        String at = fin.equals("Pending") ? "" : finL == null ? "" : Js.str(finL, "at");
        if ("ticket".equals(shape)) {
            out.put("treasurerApproval", fin); out.put("treasurerApprovedBy", by); out.put("treasurerApprovedAt", at);
        } else {
            out.put("finalApproval", fin); out.put("finalApprovedBy", by); out.put("finalApprovedAt", at);
        }
        return out;
    }

    private static JsonNode lastOf(List<JsonNode> steps) {
        JsonNode last = null;
        for (JsonNode s : steps) for (JsonNode d : Js.list(s, "decisions")) if (!Js.is(d, "value", "Pending")) last = d;
        return last;
    }
}
