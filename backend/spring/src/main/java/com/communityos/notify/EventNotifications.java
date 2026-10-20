package com.communityos.notify;

import com.communityos.amenities.AmenityEngine;
import com.communityos.finance.FinDates;
import com.communityos.finance.SystemWriter;
import com.communityos.domain.QuerySpec;
import com.communityos.security.ApprovalEngine;
import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * The messages a save sets off: a task assigned or moved on, a quotation or invoice waiting for an approver (or decided), a new forum topic or poll, a reply,
 * a chat message on a task, a release that needs approval or was paid, and the "last chance to vote" reminder. A port of notifyTicketChange /
 * notifyApprovalNeeded / notifyInvoiceChange (src/lib/notifications.js) and notifyAfterWrite / runBallotReminders (src/lib/notifyExtra.js). Held equal to the
 * JavaScript by NotifyConformanceCheck.
 *
 * Each message is written by the Notifier in the caller's transaction; the caller decides what a failure means (SecureRecordService logs it and carries on).
 */
public class EventNotifications {
    private static final Pattern TAGS = Pattern.compile("<[^>]*>");
    private static final Pattern PAREN_SUFFIX = Pattern.compile(" \\(.*\\)$");
    private final SystemWriter w;
    private final Notifier notifier;

    public EventNotifications(SystemWriter w, Notifier notifier) { this.w = w; this.notifier = notifier; }

    // ---- small helpers -------------------------------------------------------------------------------------------------

    private static JsonNode f(JsonNode r, String k) { return Js.f(r, k); }
    private static String s(JsonNode n) { return Js.toStr(n); }
    private static String or(JsonNode n, String dflt) { return Js.truthy(n) ? Js.toStr(n) : dflt; }
    private static String ticketLink(JsonNode ticketNumber) { return "#/ticket/" + s(ticketNumber); }

    /** `.length` of `x || []`: a list or a text has one; any other truthy value does not (NaN: every comparison is false). */
    private static double lengthOf(JsonNode v) {
        if (!Js.truthy(v)) return 0;
        if (v.isArray()) return v.size();
        if (v.isTextual()) return v.asText().length();
        return Double.NaN;
    }

    private ObjectNode ticketExtra(JsonNode t) {
        ObjectNode e = w.json().createObjectNode();
        Js.set(e, "ticketId", f(t, "id")); Js.set(e, "ticketNumber", f(t, "ticketNumber")); Js.set(e, "ticketTitle", f(t, "title"));
        return e;
    }

    private ArrayNode ids(List<JsonNode> list) { ArrayNode a = w.json().createArrayNode(); for (JsonNode n : list) a.add(n.isMissingNode() ? NullNode.getInstance() : n); return a; }
    private static JsonNode idOf(JsonNode role) { JsonNode id = f(role, "id"); return id.isMissingNode() ? NullNode.getInstance() : id; }
    private List<JsonNode> roleIdsIn(List<JsonNode> roles, Set<String> wanted) { List<JsonNode> out = new ArrayList<>(); for (JsonNode r : roles) if (r.get("id") != null && r.get("id").isTextual() && wanted.contains(r.get("id").asText())) out.add(idOf(r)); return out; }
    private List<JsonNode> roleIdsOfCategories(List<JsonNode> roles, String... cats) {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode r : roles) { String c = Js.text(r, "category"); if (c != null && List.of(cats).contains(c)) out.add(idOf(r)); }
        return out;
    }
    private static JsonNode roleById(List<JsonNode> roles, JsonNode id) { for (JsonNode r : roles) if (Js.strictEq(f(r, "id"), id)) return r; return null; }

    // ---- tasks ---------------------------------------------------------------------------------------------------------

    /**
     * Called after a task is saved. `old` is the previous row (null on create), `next` the saved one.
     * Assignment -> the assignee; status change -> the task's owner; decisions -> whoever raised or does the task. The person who made the change is never told.
     */
    public void ticketChange(String tenant, JsonNode old, JsonNode next, Principal actor) {
        List<JsonNode> roles = w.repo().list(tenant, "roles"), users = w.repo().list(tenant, "users");
        List<Notifier.Item> out = new ArrayList<>();
        String by = actor == null || actor.name() == null ? "" : actor.name();
        boolean community = Js.is(next, "scope", "Community");
        String link = ticketLink(f(next, "ticketNumber"));
        String nr = s(f(next, "ticketNumber")), title = s(f(next, "title"));
        if (old == null && community) {
            out.add(new Notifier.Item("ticket_assigned", "Community request · " + nr, title + " — " + or(f(next, "location"), "common area") + ", raised by " + or(f(next, "createdBy"), "a resident") + " (" + s(f(next, "unit")) + ").")
                    .kind("community").link(link).toRoleIds(ids(roleIdsIn(roles, Set.of("facility_manager", "handyman_mep", "helpdesk")))));
        }
        if (old != null && community && lengthOf(f(next, "affectedUnits")) > lengthOf(f(old, "affectedUnits"))) {
            out.add(new Notifier.Item("ticket_assigned", nr + ": " + Js.numberToString(lengthOf(f(next, "affectedUnits"))) + " villas affected", title + " — " + or(f(next, "location"), "common area") + ": another resident said “me too”.")
                    .kind("community").link(link).toRoleIds(ids(roleIdsIn(roles, Set.of("facility_manager", "handyman_mep", "helpdesk")))));
        }
        JsonNode assigned = f(next, "assignedTo");
        if (Js.truthy(assigned) && !Js.strictEq(assigned, f(old, "assignedTo"))) {
            JsonNode u = null;
            for (JsonNode x : users) if (Js.strictEq(f(x, "name"), assigned)) { u = x; break; }
            List<JsonNode> roleIds = new ArrayList<>();
            if (u != null) { roleIds.add(f(u, "roleId")); if (f(u, "extraRoleIds").isArray()) f(u, "extraRoleIds").forEach(roleIds::add); }
            out.add(new Notifier.Item("ticket_assigned", "New task assigned · " + nr, title + " was assigned to you" + (Js.truthy(actorName(actor)) ? " by " + by : "") + ".")
                    .kind("assigned").link(link).toName(assigned).toRoleIds(ids(roleIds)));
        }
        if (old != null && !Js.strictEq(f(next, "status"), f(old, "status"))) {
            JsonNode createdByRole = f(next, "createdByRole");
            JsonNode role = roleById(roles, createdByRole);
            boolean resident = Js.truthy(next, "unit") && role != null && Js.is(role, "category", "Resident");
            Notifier.Item it = new Notifier.Item("ticket_status", nr + " is now " + s(f(next, "status")), title + ": " + s(f(old, "status")) + " → " + s(f(next, "status")) + (Js.truthy(actorName(actor)) ? " (" + by + ")" : "") + ".")
                    .kind("status").link(link).toName(Js.truthy(next, "createdBy") ? f(next, "createdBy") : TextNode.valueOf(""));
            if (resident) it.toUnit(f(next, "unit"));
            else { ArrayNode a = w.json().createArrayNode(); if (Js.truthy(createdByRole)) a.add(createdByRole); it.toRoleIds(a); }
            out.add(it);
        }
        for (String[] fw : new String[][] {{"ecApproval", "EC"}, {"treasurerApproval", "Final"}}) {
            JsonNode now = f(next, fw[0]);
            if (old != null && !Js.strictEq(now, f(old, fw[0])) && (Js.is(next, fw[0], "Approved") || Js.is(next, fw[0], "Rejected"))) {
                LinkedHashSet<JsonNode> names = new LinkedHashSet<>();
                for (JsonNode n : new JsonNode[] {f(next, "assignedTo"), f(next, "createdBy")}) if (Js.truthy(n)) names.add(n);
                String verdict = now.asText().toLowerCase(java.util.Locale.ROOT);
                for (JsonNode nm : names)
                    out.add(new Notifier.Item("ticket_decision", nr + ": " + fw[1] + " approval " + verdict, fw[1] + " approval on " + title + " was " + verdict + (Js.truthy(actorName(actor)) ? " by " + by : "") + ".")
                            .kind("decision").link(link).toName(nm));
            }
        }
        for (Notifier.Item row : out) {
            if (mine(row, actor)) continue;   // don't notify yourself
            row.by(by).extra(ticketExtra(next));
            notifier.notify(tenant, row);
        }
    }

    private static JsonNode actorName(Principal p) { return p == null || p.name() == null ? Js.MISSING : TextNode.valueOf(p.name()); }

    private static boolean mine(Notifier.Item row, Principal actor) {
        JsonNode name = actorName(actor);
        if (Js.strictEq(row.toName == null ? Js.MISSING : row.toName, name)) return true;
        if (actor != null && row.toRoleIds != null && row.toRoleIds.isArray()) for (JsonNode r : row.toRoleIds) if (actor.roleId() != null && Js.strictEq(r, TextNode.valueOf(actor.roleId()))) return true;
        return Js.truthy(row.toUnit) && actor != null && Js.strictEq(row.toUnit, TextNode.valueOf(actor.unit() == null ? "" : actor.unit()));
    }

    /** Which roles have to act next: the EC roles, or the final approvers. */
    private List<JsonNode> approvers(String tenant, String waiting, List<JsonNode> roles) {
        if (waiting.equals("ec")) return roleIdsOfCategories(roles, "EC");
        return TicketApprovals.finalApproverRoleIds(w.repo().list(tenant, "approverSettings"));
    }

    /** A quotation now waits for the EC or the final approvers: tell exactly those roles. */
    public void approvalNeeded(String tenant, JsonNode old, JsonNode next, Principal actor) {
        List<JsonNode> roles = w.repo().list(tenant, "roles");
        JsonNode type = Js.MISSING;
        for (JsonNode x : w.repo().list(tenant, "taskTypes")) if (Js.strictEq(f(x, "name"), f(next, "taskType"))) { type = x; break; }
        String before = TicketApprovals.approvalState(old, type).waitingOn();
        String after = TicketApprovals.approvalState(next, type).waitingOn();
        if (after == null || after.equals(before)) return;
        List<JsonNode> to = approvers(tenant, after.equals("ec") ? "ec" : "final", roles);
        String step = after.equals("ec") ? "EC approval" : "final approval (Treasurer / President)";
        notifier.notify(tenant, new Notifier.Item("approval", step + " needed · " + s(f(next, "ticketNumber")), s(f(next, "title")) + ": the selected quotation waits for your " + step + ". Open the task → Money.")
                .link(ticketLink(f(next, "ticketNumber"))).toRoleIds(ids(to)).by(actor == null ? "" : actor.name()).extra(ticketExtra(next)));
    }

    /** An invoice (a quotations row of kind Invoice) now waits for an approver, or was decided: tell the approvers, or the people doing the work. */
    public void invoiceChange(String tenant, JsonNode old, JsonNode next, Principal actor) {
        if (!Js.is(next, "kind", "Invoice")) return;
        JsonNode t = null;
        for (JsonNode x : w.repo().list(tenant, "tickets")) if (Js.strictEq(f(x, "id"), f(next, "ticketId"))) { t = x; break; }
        if (t == null) return;
        List<JsonNode> roles = w.repo().list(tenant, "roles");
        TicketApprovals.State before = Js.truthy(old) ? TicketApprovals.invoiceApproval(old) : new TicketApprovals.State(null, "", null);
        TicketApprovals.State st = TicketApprovals.invoiceApproval(next);
        String link = ticketLink(f(t, "ticketNumber"));
        String by = actor == null || actor.name() == null ? "" : actor.name();
        String what = or(f(next, "vendor"), "Invoice") + " invoice of " + FinDates.rupees(f(next, "amount")) + " on " + s(f(t, "title"));
        if (st.waitingOn() != null && !st.waitingOn().equals(before.waitingOn())) {
            String who = st.waitingOn().equals("ec") ? "EC" : "Final", word = st.waitingOn().equals("ec") ? "EC" : "final";
            notifier.notify(tenant, new Notifier.Item("approval", who + " approval needed · " + s(f(t, "ticketNumber")), what + " waits for your " + word + " approval. Open the task → Money.")
                    .link(link).toRoleIds(ids(approvers(tenant, st.waitingOn(), roles))).by(by).extra(ticketExtra(t)));
        } else if ((st.key().equals("rejected") || st.key().equals("approved")) && !st.key().equals(before.key())) {
            LinkedHashSet<JsonNode> names = new LinkedHashSet<>();
            for (JsonNode n : new JsonNode[] {f(t, "assignedTo"), f(t, "createdBy")}) if (Js.truthy(n)) names.add(n);
            String verdict = st.key().equals("approved") ? "fully approved" : st.label().toLowerCase(java.util.Locale.ROOT);
            for (JsonNode nm : names) {
                if (Js.strictEq(nm, actorName(actor))) continue;
                notifier.notify(tenant, new Notifier.Item("ticket_decision", s(f(t, "ticketNumber")) + ": invoice " + verdict, what + " is " + verdict + (Js.truthy(actorName(actor)) ? " (" + by + ")" : "") + ".")
                        .link(link).toName(nm).by(by).extra(ticketExtra(t)));
            }
        }
    }

    // ---- everything else -------------------------------------------------------------------------------------------------

    static String safe(JsonNode v) {
        String t = Js.truthy(v) ? Js.toStr(v) : "";
        t = TAGS.matcher(t).replaceAll(" ");
        StringBuilder b = new StringBuilder();
        boolean space = false;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (Js.isSpace(c)) { if (!space) b.append(' '); space = true; } else { b.append(c); space = false; }
        }
        return Js.trim(b.toString());
    }
    static String clip(JsonNode v) { String t = safe(v); return t.length() > 110 ? t.substring(0, 110) + "…" : t; }

    private static final Set<String> HANDLED = Set.of("forum", "forumPosts", "ballots", "ticketComments", "tickets", "releases");

    public static boolean handles(String collection) { return HANDLED.contains(collection); }

    private List<JsonNode> approverRoleIds(String tenant, JsonNode step, List<JsonNode> roles) {
        LinkedHashSet<JsonNode> ids = new LinkedHashSet<>();
        JsonNode list = f(step, "approvers");
        if (list.isArray()) for (JsonNode a : list) {
            if (Js.is(a, "kind", "role")) ids.add(f(a, "value").isMissingNode() ? NullNode.getInstance() : f(a, "value"));
            else if (Js.is(a, "kind", "group") && Js.is(a, "value", "EC members")) ids.addAll(roleIdsOfCategories(roles, "EC"));
            else if (Js.is(a, "kind", "group") && Js.is(a, "value", "Final approvers")) ids.addAll(TicketApprovals.finalApproverRoleIds(w.repo().list(tenant, "approverSettings")));
        }
        return new ArrayList<>(ids);
    }

    private static String stepWho(JsonNode step, Function<JsonNode, String> roleName) {
        List<String> parts = new ArrayList<>();
        for (JsonNode a : Js.list(step, "approvers")) parts.add(Js.is(a, "kind", "group") ? s(f(a, "value")) : Js.is(a, "kind", "role") ? roleName.apply(f(a, "value")) : s(f(a, "value")));
        double needed = Js.number(step, "needed");
        return String.join(" or ", parts) + ((needed != 0 ? needed : 1) > 1 ? " (any " + s(f(step, "needed")) + ")" : "");
    }

    /** After any successful write: the notifications of forum, polls, e-voting results, task chat, new requests and releases. */
    public void afterWrite(String tenant, String collection, JsonNode old, JsonNode next, Principal actor) {
        if (!HANDLED.contains(collection)) return;
        List<JsonNode> roles = w.repo().list(tenant, "roles");
        String by = actor == null || actor.name() == null ? "" : actor.name();
        boolean created = old == null;

        if (collection.equals("forum") && created) {
            boolean poll = Js.is(next, "kind", "Poll");
            notifier.notify(tenant, new Notifier.Item(poll ? "poll" : "forum_topic", (poll ? "New poll" : "New forum topic") + " · " + s(f(next, "title")),
                    (by.isEmpty() ? "A neighbour" : by) + " started “" + s(f(next, "title")) + "” in " + or(f(next, "category"), "the forum") + ".")
                    .link("#/forum/" + s(f(next, "id"))).toRoleIds(ids(roleIdsOfCategories(roles, "Resident", "EC"))).by(by));
        }

        if (collection.equals("forumPosts") && created) {
            JsonNode topic = getOne(tenant, "forum", f(next, "topicId"));
            JsonNode parent = Js.truthy(next, "parentId") ? getOne(tenant, "forumPosts", f(next, "parentId")) : null;
            LinkedHashSet<JsonNode> names = new LinkedHashSet<>();
            JsonNode author = Js.truthy(topic, "author") ? f(topic, "author") : TextNode.valueOf(PAREN_SUFFIX.matcher(Js.orEmpty(f(topic, "recordCreatedBy"))).replaceFirst(""));
            if (Js.truthy(author)) names.add(author);
            if (Js.truthy(parent, "author")) names.add(f(parent, "author"));
            names.remove(TextNode.valueOf(by));
            for (JsonNode nm : names)
                notifier.notify(tenant, new Notifier.Item("forum_reply", "New reply · " + or(f(topic, "title"), "forum"), (by.isEmpty() ? "Someone" : by) + " replied: " + clip(f(next, "body")))
                        .link("#/forum/" + s(f(next, "topicId"))).toName(nm).by(by));
        }

        if (collection.equals("ballots") && old != null && !Js.is(old, "status", "Closed") && Js.is(next, "status", "Closed")) {
            notifier.notify(tenant, new Notifier.Item("ballot_result", "Voting closed · " + s(f(next, "title")), "The votes are counted. Open E-voting to see the result and verify your receipt.")
                    .link("#/ballot/" + s(f(next, "id"))).toRoleIds(ids(roleIdsOfCategories(roles, "Resident", "EC"))).by(by));
        }

        if (collection.equals("ticketComments") && created && !Js.is(next, "authorRoleId", "system")) {
            JsonNode t = getOne(tenant, "tickets", f(next, "ticketId"));
            if (t != null) {
                boolean pub = !Js.is(next, "visibility", "Internal");
                LinkedHashSet<JsonNode> names = new LinkedHashSet<>();
                if (Js.truthy(t, "assignedTo")) names.add(f(t, "assignedTo"));
                if (pub && Js.truthy(t, "createdBy")) names.add(f(t, "createdBy"));
                names.remove(f(next, "author")); names.remove(TextNode.valueOf(by));
                for (JsonNode nm : names)
                    notifier.notify(tenant, new Notifier.Item("ticket_chat", "New message · " + s(f(t, "ticketNumber")), or(f(next, "author"), by) + ": " + clip(f(next, "body")))
                            .link("#/ticket/" + s(f(t, "ticketNumber")) + "/chat").toName(nm).by(by).extra(ticketExtra(t)));
            }
        }

        if (collection.equals("tickets") && created && !Js.is(next, "scope", "Community")) {
            JsonNode role = roleById(roles, f(next, "createdByRole"));
            boolean resident = role != null && Js.is(role, "category", "Resident");
            if (resident) {
                String body = s(f(next, "title")) + (Js.truthy(next, "location") ? " — " + s(f(next, "location")) : "") + ". " + (Js.truthy(next, "assignedTo") ? "" : "Not assigned yet.");
                notifier.notify(tenant, new Notifier.Item("ticket_new", "New request from " + or(f(next, "unit"), "a resident") + " · " + s(f(next, "ticketNumber")), Js.trim(body))
                        .link("#/ticket/" + s(f(next, "ticketNumber"))).toRoleIds(ids(roleIdsIn(roles, Set.of("facility_manager", "helpdesk")))).by(by).extra(ticketExtra(next)));
            }
        }

        if (collection.equals("releases")) releases(tenant, old, next, by, roles);
    }

    private void releases(String tenant, JsonNode old, JsonNode next, String by, List<JsonNode> roles) {
        boolean cultural = Js.truthy(next, "expenseId");
        String link = cultural ? "#/cultural" : Js.truthy(next, "ticketShortId") ? "#/ticket/" + s(f(next, "ticketShortId")) : "#/billing";
        String what = FinDates.rupees(f(next, "amount")) + " release to " + or(f(next, "vendor"), "a payee") + (Js.truthy(next, "ticketShortId") ? " (" + s(f(next, "ticketShortId")) + ")" : "");
        ApprovalEngine.PlanState was = ApprovalEngine.planState(ApprovalEngine.parsePlan(f(old, "plan")));
        ApprovalEngine.PlanState now = ApprovalEngine.planState(ApprovalEngine.parsePlan(f(next, "plan")));
        if (now.key().equals("pending") && (old == null || !was.key().equals("pending") || was.index() != now.index())) {
            List<JsonNode> to = approverRoleIds(tenant, now.step(), roles);
            if (!to.isEmpty())
                notifier.notify(tenant, new Notifier.Item("approval", "Release approval needed" + (Js.truthy(next, "ticketShortId") ? " · " + s(f(next, "ticketShortId")) : ""),
                        what + " waits for " + stepWho(now.step(), id -> { JsonNode r = roleById(roles, id); return r != null && Js.truthy(r, "name") ? s(f(r, "name")) : s(id); }) + ".")
                        .link(link).toRoleIds(ids(to)).by(by));
        }
        JsonNode requester = Js.truthy(next, "requestedBy") ? f(next, "requestedBy") : f(next, "recordCreatedBy");
        if (old != null && now.key().equals("approved") && !was.key().equals("approved")) {
            notifier.notify(tenant, new Notifier.Item("ticket_decision", "Release approved", what + " is approved and now in Payments.").link(link).toName(requester).by(by));
            ArrayNode treasurer = w.json().createArrayNode(); treasurer.add("treasurer");
            notifier.notify(tenant, new Notifier.Item("payment_made", "Release ready to pay", what + " is approved. Open Payments.").link("#/billing").toRoleIds(treasurer).by(by));
        }
        if (old != null && now.key().equals("rejected") && !was.key().equals("rejected"))
            notifier.notify(tenant, new Notifier.Item("ticket_decision", "Release rejected", what + " was rejected.").link(link).toName(requester).by(by));
        if (old != null && !Js.is(old, "status", "Paid") && Js.is(next, "status", "Paid"))
            notifier.notify(tenant, new Notifier.Item("payment_made", "Release paid", what + " has been paid.").link(link).toName(requester).by(by));
    }

    private JsonNode getOne(String tenant, String collection, JsonNode id) {
        if (id == null || !id.isTextual()) return null;
        return w.repo().get(tenant, collection, id.asText()).orElse(null);
    }

    // ---- e-voting: last chance ---------------------------------------------------------------------------------------

    /** Open ballots closing within 2 days: remind each villa that has not voted yet, once per ballot. @return how many reminders were sent */
    public int ballotReminders(String tenant, ZoneId zone) {
        List<JsonNode> ballots = new ArrayList<>();
        for (JsonNode b : w.repo().list(tenant, "ballots")) if (Js.is(b, "status", "Open") && Js.truthy(b, "closesOn")) ballots.add(b);
        if (ballots.isEmpty()) return 0;
        long now = w.clock().millis();
        int n = 0;
        for (JsonNode b : ballots) {
            double left = (AmenityEngine.parseLocal(s(f(b, "closesOn")) + "T23:59:59", zone) - now) / 86400000.0;
            if (left < 0 || left > 2 || alreadyReminded(tenant, f(b, "id"))) continue;
            Set<JsonNode> voted = new HashSet<>();
            for (JsonNode m : w.repo().list(tenant, "voteRoll")) if (Js.strictEq(f(m, "ballotId"), f(b, "id"))) voted.add(f(m, "unit"));
            LinkedHashSet<JsonNode> units = new LinkedHashSet<>();
            for (JsonNode r : Js.list(b, "roll")) units.add(f(r, "unit"));
            for (JsonNode u : units) {
                if (voted.contains(u)) continue;
                ObjectNode extra = w.json().createObjectNode(); Js.set(extra, "ballotId", f(b, "id"));
                notifier.notify(tenant, new Notifier.Item("ballot", "Last chance to vote · " + s(f(b, "title")), "Voting closes on " + s(f(b, "closesOn")) + ". " + s(u) + " has not voted yet.")
                        .kind("ballot_reminder").link("#/ballot/" + s(f(b, "id"))).toUnit(u).by("System").extra(extra));
                n++;
            }
        }
        return n;
    }

    /** `sent.some(x => x.kind === 'ballot_reminder' && x.ballotId === b.id)`, asked of the database instead of reading every notification. */
    private boolean alreadyReminded(String tenant, JsonNode ballotId) {
        if (!ballotId.isTextual()) return false;
        QuerySpec q = new QuerySpec(1, 1, "", "asc", "", List.of(), "", "", "", "", "", "", Map.of("kind", List.of("ballot_reminder"), "ballotId", List.of(ballotId.asText())));
        return w.repo().query(tenant, "notifications", q).total() > 0;
    }
}
