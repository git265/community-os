package com.communityos.security;

import static com.communityos.security.Perms.isAdmin;
import static com.communityos.security.Perms.isEC;
import static com.communityos.security.Perms.isSecondApprover;

import com.communityos.security.ApprovalEngine.Helpers;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Rules-driven approvals (planChange in authz.js): a record's `plan` (JSON) holds the steps and who decided them. When the plan changes, the actor
 * must be eligible for the step they decided (EC / final approvers / a named role or person), decide as themselves, and the old two-slot fields
 * must match what the plan says.
 */
final class PlanRules {
    private PlanRules() {}

    static Helpers helpers(Principal ignored, RuleContext ctx) {
        return new Helpers(
                (q) -> isEC(q) && (ctx.finalCanDecideEC() || isAdmin(q) || !ctx.secondStepRoles().contains(q.roleId())),
                (q) -> isSecondApprover(q, ctx),
                Perms::isAdmin);
    }

    private static String plain(JsonNode n) { return n == null ? "null" : Js.stringify(n); }

    /** Returns null when the plan did not change (the classic role checks then apply), OK, or a refusal. `shape` is "doc", "ticket" or "expense". */
    static Verdict planChange(Principal p, JsonNode old, JsonNode next, String shape, RuleContext ctx) {
        JsonNode np = ApprovalEngine.parsePlan(Js.f(next, "plan"));
        JsonNode op = ApprovalEngine.parsePlan(Js.f(old, "plan"));
        if (np == null || plain(op).equals(plain(np))) return null;
        if (!Js.f(np, "steps").isArray()) return Verdict.deny("The approval plan is not valid");
        JsonNode oOver = arrayOrEmpty(op, "overrides"); JsonNode nOver = arrayOrEmpty(np, "overrides");
        if (!plain(oOver).equals(plain(nOver))) {
            if (!isAdmin(p)) return Verdict.deny("Only a Super Admin can change the approvals of one task");
            boolean oneMore = nOver.size() == oOver.size() + 1;
            String reason = nOver.size() == 0 ? "" : Js.str(nOver.get(nOver.size() - 1), "reason");
            if (!oneMore || reason.trim().isEmpty()) return Verdict.deny("Give a reason for changing the approvals");
        }
        JsonNode base = op != null ? op : withEmptyDecisions(np);
        ApprovalEngine.PlanState cur = ApprovalEngine.planState(base);
        Helpers h = helpers(p, ctx);
        JsonNode steps = Js.f(np, "steps");
        for (int i = 0; i < steps.size(); i++) {
            List<JsonNode> o = Js.list(Js.at(Js.f(base, "steps"), i), "decisions");
            List<JsonNode> n = Js.list(steps.get(i), "decisions");
            if (n.size() > o.size()) {
                List<JsonNode> added = n.subList(o.size(), n.size());
                if (added.stream().anyMatch((d) -> !p.name().equals(Js.text(d, "by")) && !isAdmin(p))) return Verdict.deny("An approval is always recorded in your own name");
                JsonNode stepNow = cur.key().equals("pending") ? cur.step() : null;
                JsonNode target = op != null ? stepNow : steps.get(i);
                if (target == null || (op != null && cur.index() != i)) return Verdict.deny("That step is not waiting for a decision");
                if (!ApprovalEngine.stepEligible(target, p, h)) {
                    List<String> who = new ArrayList<>();
                    for (JsonNode a : Js.list(target, "approvers")) who.add(Js.str(a, "value"));
                    return Verdict.deny("Only " + String.join(" or ", who) + " can decide this step");
                }
            } else if (n.size() < o.size()) {
                List<JsonNode> gone = o.stream().filter((d) -> n.stream().noneMatch((x) -> Js.strictEq(Js.f(x, "by"), Js.f(d, "by")) && Js.strictEq(Js.f(x, "at"), Js.f(d, "at")) && Js.strictEq(Js.f(x, "value"), Js.f(d, "value")))).toList();
                if (gone.stream().anyMatch((d) -> !p.name().equals(Js.text(d, "by")) && !isAdmin(p))) return Verdict.deny("Only the person who decided can undo it");
            }
        }
        Map<String, Object> want = ApprovalEngine.legacy(np, shape);
        boolean bad = false;
        for (Map.Entry<String, Object> e : want.entrySet()) {
            JsonNode have = Js.f(next, e.getKey());
            boolean haveNull = have.isMissingNode() || have.isNull();
            Object w = e.getValue();
            if (haveNull && w == null) continue;
            JsonNode haveCmp = haveNull ? JsonNodeFactory.instance.textNode("") : have;
            JsonNode wantCmp = w == null ? JsonNodeFactory.instance.textNode("") : w instanceof Boolean b ? JsonNodeFactory.instance.booleanNode(b) : JsonNodeFactory.instance.textNode(String.valueOf(w));
            if (!Js.strictEq(haveCmp, wantCmp)) bad = true;
        }
        if (bad && !"expense".equals(shape)) return Verdict.deny("The approval fields do not match the approval steps");
        return Verdict.OK;
    }

    private static JsonNode arrayOrEmpty(JsonNode plan, String key) {
        JsonNode a = Js.f(plan, key);
        return a.isArray() ? a : JsonNodeFactory.instance.arrayNode();
    }

    private static JsonNode withEmptyDecisions(JsonNode plan) {
        ObjectNode o = JsonNodeFactory.instance.objectNode();
        ArrayNode steps = o.putArray("steps");
        for (JsonNode s : Js.list(plan, "steps")) {
            ObjectNode c = s.isObject() ? ((ObjectNode) s).deepCopy() : JsonNodeFactory.instance.objectNode();
            c.putArray("decisions");
            steps.add(c);
        }
        return o;
    }
}
