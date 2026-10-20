package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.NullNode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * "How much may still be released or paid on this task", and the rules that keep releases, payments, quotations / invoices and task approvals
 * honest. A port of src/lib/approval/moneyGuard.js (moneyPreWrite) and the two functions of modules/tickets/ticketEngine.js it uses
 * (invoiceApproval, approvalState). The rules apply to everyone, the Super Admin included. Corrections never edit history: a wrong payment is
 * reversed by a matching credit row, a wrong release is cancelled with a reason, an approved invoice is sent back (only while nothing is paid on it).
 *
 * Held equal to the JavaScript by MoneyGuardConformanceCheck (thousands of write attempts generated from the real code). The JavaScript habits
 * that matter are kept on purpose: `undefined === undefined` is true (a task without an id matches documents without a ticketId), Math.round
 * rounds halves up, and amounts are `Number(x) || 0`.
 */
public final class MoneyGuard {
    private MoneyGuard() {}

    static final double TOLERANCE = 0.5;
    static final List<String> DEAD_RELEASE = List.of("Rejected", "Cancelled");
    static final List<String> PAYMENT_LOCKED = List.of("amount", "type", "account", "sourceId", "sourceType", "tdsAmount", "tdsRate", "tdsSection", "reversalOf", "baseAmount", "gstAmount", "gstRate");

    /** The collections these rules look at. */
    public static boolean covers(String collection) { return "releases".equals(collection) || "ledger".equals(collection) || "quotations".equals(collection) || "tickets".equals(collection); }

    // ---- small JavaScript helpers -----------------------------------------------------------------------------------------

    public static double r2(double n) { return Math.floor((n + Math.ulp(1.0) * 1) * 100 + 0.5) / 100; }   // Math.round((n + Number.EPSILON) * 100) / 100; Math.ulp(1.0) == Number.EPSILON

    /** `String(x)`: undefined and null print as words, unlike Js.str. */
    private static String jsString(JsonNode rec, String key) {
        JsonNode n = Js.f(rec, key);
        if (n.isMissingNode()) return "undefined";
        if (n.isNull()) return "null";
        return Js.str(n);
    }
    private static String lower(String s) { return s.toLowerCase(java.util.Locale.ROOT); }

    /** The default of `exceptReleaseId = ''`, as a key. */
    static final String NO_EXCEPT = "s:";

    private static double num(JsonNode rec, String key) { return Js.number(rec, key); }

    /** `a === b` for two fields. */
    private static boolean eq(JsonNode a, String ka, JsonNode b, String kb) { return Js.strictEq(Js.f(a, ka), Js.f(b, kb)); }

    /** A value as a set element: undefined, null, "1" and 1 stay different (SameValueZero). */
    private static String key(JsonNode n) {
        if (n == null || n.isMissingNode()) return "\u0000undefined";
        if (n.isNull()) return "\u0000null";
        if (n.isTextual()) return "s:" + n.asText();
        if (n.isNumber()) return "n:" + Js.str(n);
        if (n.isBoolean()) return "b:" + n.asBoolean();
        return "o:" + System.identityHashCode(n);
    }

    private static String keyOf(JsonNode rec, String field) { return key(Js.f(rec, field)); }

    private static JsonNode nn(JsonNode n) { return n == null || n.isMissingNode() ? NullNode.getInstance() : n; }

    /** `JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)` */
    private static List<String> keysChanged(JsonNode a, JsonNode b, List<String> keys) {
        List<String> out = new ArrayList<>();
        for (String k : keys) if (Js.differs(nn(Js.f(a, k)), nn(Js.f(b, k)))) out.add(k);
        return out;
    }

    static String trim(String s) { return Js.trim(s); }

    /** `₹${Math.round(num(n)).toLocaleString('en-IN')}`: lakh / crore grouping (12,34,567). */
    public static String money(double n) {
        long v = (long) Math.floor(n + 0.5);
        boolean negZero = v == 0 && n < 0;   // Math.round(-0.3) is -0, which prints as "-0"
        String digits = Long.toString(Math.abs(v));
        StringBuilder sb = new StringBuilder();
        if (digits.length() <= 3) sb.append(digits);
        else {
            String head = digits.substring(0, digits.length() - 3), tail = digits.substring(digits.length() - 3);
            StringBuilder g = new StringBuilder();
            for (int i = 0; i < head.length(); i++) {
                if (i > 0 && (head.length() - i) % 2 == 0) g.append(',');
                g.append(head.charAt(i));
            }
            sb.append(g).append(',').append(tail);
        }
        return "₹" + (v < 0 || negZero ? "-" : "") + sb;
    }

    private static List<JsonNode> filter(List<JsonNode> rows, java.util.function.Predicate<JsonNode> p) {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode r : rows) if (p.test(r)) out.add(r);
        return out;
    }

    private static JsonNode find(List<JsonNode> rows, java.util.function.Predicate<JsonNode> p) {
        for (JsonNode r : rows) if (p.test(r)) return r;
        return null;
    }

    // ---- approval state (ticketEngine.js) -----------------------------------------------------------------------------------

    /** One invoice's approval key: none | unselected | approved | rejected | pending-ec | pending-final. */
    static String invoiceKey(JsonNode doc) {
        if (doc == null) return "none";
        if (Js.strictEq(Js.f(doc, "selected"), com.fasterxml.jackson.databind.node.BooleanNode.FALSE)) return "unselected";
        if (Js.truthy(doc, "approvalWaived")) return "approved";
        if (Js.is(doc, "ecApproval", "Rejected")) return "rejected";
        if (Js.is(doc, "finalApproval", "Rejected")) return "rejected";
        if (!Js.is(doc, "ecApproval", "Approved")) return "pending-ec";
        if (Js.strictEq(Js.f(doc, "finalRequired"), com.fasterxml.jackson.databind.node.BooleanNode.FALSE)) return "approved";
        if (!Js.is(doc, "finalApproval", "Approved")) return "pending-final";
        return "approved";
    }

    /** The task-level approval of the selected quotation (task type unknown, as the storage layer calls it): none | rejected | pending-ec | pending-treasurer | approved. */
    static String ticketKey(JsonNode ticket) {
        if (ticket == null || !Js.truthy(ticket, "selectedQuotationId")) return "none";
        boolean fin = Js.truthy(ticket, "financial");
        if (Js.is(ticket, "ecApproval", "Rejected")) return "rejected";
        if (Js.is(ticket, "treasurerApproval", "Rejected")) return "rejected";
        boolean ecOk = Js.is(ticket, "ecApproval", "Approved"), trOk = Js.is(ticket, "treasurerApproval", "Approved");
        if (fin && !ecOk) return "pending-ec";
        if (ecOk && Js.strictEq(Js.f(ticket, "finalRequired"), com.fasterxml.jackson.databind.node.BooleanNode.FALSE)) return "approved";
        if (fin && !trOk) return "pending-treasurer";
        if (ecOk || trOk) return "approved";
        return "none";
    }

    private static boolean isApproved(JsonNode d) { return "approved".equals(invoiceKey(d)); }
    private static boolean ticketApproved(JsonNode t) { return "approved".equals(ticketKey(t)); }

    // ---- the money position of a task ----------------------------------------------------------------------------------------

    static double grossOf(JsonNode l) { return r2(num(l, "amount") + num(l, "tdsAmount")); }

    static Set<String> reversedIds(List<JsonNode> ledger) {
        Set<String> s = new HashSet<>();
        for (JsonNode l : ledger) if (Js.truthy(l, "reversalOf")) s.add(keyOf(l, "reversalOf"));
        return s;
    }

    /** Debit rows that still count: not reversed, not an internal bookkeeping entry. */
    static List<JsonNode> liveDebits(List<JsonNode> ledger) {
        Set<String> rev = reversedIds(ledger);
        return filter(ledger, l -> Js.is(l, "type", "Debit") && !Js.truthy(l, "internal") && !rev.contains(keyOf(l, "id")));
    }

    static List<JsonNode> taskLedger(JsonNode ticket, List<JsonNode> docs, List<JsonNode> releases, List<JsonNode> ledger) {
        Set<String> ids = new HashSet<>();
        ids.add(keyOf(ticket, "id"));
        for (JsonNode d : docs) if (eq(d, "ticketId", ticket, "id")) ids.add(keyOf(d, "id"));
        for (JsonNode r : releases) if (eq(r, "ticketId", ticket, "id")) ids.add(keyOf(r, "id"));
        return filter(liveDebits(ledger), l -> (Js.truthy(ticket, "ticketNumber") && eq(l, "taskRef", ticket, "ticketNumber")) || ids.contains(keyOf(l, "sourceId")));
    }

    /** @param remaining null when nothing is approved yet (the approvers decide) */
    record Money(String basis, double cap, double invApproved, double quoted, double releasedLive, double direct, double paid, double committed, Double remaining, boolean closed) {}

    static Money taskMoney(JsonNode ticket, List<JsonNode> docs, List<JsonNode> releases, List<JsonNode> ledger, String exceptReleaseKey) {
        List<JsonNode> mineDocs = filter(docs, d -> eq(d, "ticketId", ticket, "id"));
        double invApproved = 0;
        for (JsonNode d : mineDocs) if (Js.is(d, "kind", "Invoice") && !Js.strictEq(Js.f(d, "selected"), com.fasterxml.jackson.databind.node.BooleanNode.FALSE) && isApproved(d)) invApproved += num(d, "amount");
        invApproved = r2(invApproved);
        boolean quoteOk = ticketApproved(ticket);
        JsonNode quote = find(mineDocs, d -> eq(d, "id", ticket, "selectedQuotationId"));
        double quoted = quoteOk ? (num(ticket, "approvedAmount") != 0 ? num(ticket, "approvedAmount") : (quote != null ? num(quote, "amount") : 0)) : 0;
        String basis = invApproved > 0 ? "Invoice" : quoted > 0 ? "Quotation" : "None";
        double cap = "Invoice".equals(basis) ? invApproved : "Quotation".equals(basis) ? quoted : 0;
        List<JsonNode> rels = filter(releases, r -> eq(r, "ticketId", ticket, "id") && !(Js.is(r, "status", "Rejected") || Js.is(r, "status", "Cancelled")) && !keyOf(r, "id").equals(exceptReleaseKey));
        Set<String> relIds = new HashSet<>();
        for (JsonNode r : releases) if (eq(r, "ticketId", ticket, "id")) relIds.add(keyOf(r, "id"));
        List<JsonNode> live = taskLedger(ticket, docs, releases, ledger);
        double direct = 0, paid = 0, releasedLive = 0;
        for (JsonNode l : live) { if (!relIds.contains(keyOf(l, "sourceId"))) direct += grossOf(l); paid += grossOf(l); }
        direct = r2(direct); paid = r2(paid);
        for (JsonNode r : rels) releasedLive += num(r, "amount");
        releasedLive = r2(releasedLive);
        double committed = r2(releasedLive + direct);
        Double remaining = cap > 0 ? Double.valueOf(Math.max(0, r2(cap - committed))) : null;
        String st = Js.text(ticket, "status");
        return new Money(basis, cap, invApproved, quoted, releasedLive, direct, paid, committed, remaining, "Closed".equals(st) || "Cancelled".equals(st));
    }

    /** Why a (new or approved) release must not go ahead: "" when fine. */
    static String releaseBlock(JsonNode ticket, Money m, double amount) {
        if (ticket == null) return "The task for this release was not found";
        if (m.closed()) return "This task is " + lower(jsString(ticket, "status")) + " - no more money can be released on it";
        if (!(amount > 0)) return "Enter the amount to release";
        String basis = m.basis().toLowerCase();
        if (m.cap() > 0 && m.remaining() <= TOLERANCE)
            return "The " + basis + " amount of " + money(m.cap()) + " is already fully " + (m.direct() > 0 && m.releasedLive() == 0 ? "paid" : "released or paid") + " (" + money(m.committed()) + "). Nothing is left to release.";
        if (m.cap() > 0 && amount > m.remaining() + TOLERANCE)
            return "Only " + money(m.remaining()) + " of " + money(m.cap()) + " (the " + basis + " amount) is left - " + money(m.committed()) + " is already released or paid";
        return "";
    }

    // ---- a payment (ledger debit) before it is recorded -----------------------------------------------------------------------

    static String paymentBlock(JsonNode row, List<JsonNode> tickets, List<JsonNode> docs, List<JsonNode> releases, List<JsonNode> ledger) {
        if (!Js.is(row, "type", "Debit") || Js.truthy(row, "internal") || Js.truthy(row, "reversalOf")) return "";
        boolean isTaskLike = Js.is(row, "sourceType", "release") || Js.is(row, "sourceType", "invoice") || Js.is(row, "sourceType", "task") || Js.truthy(row, "taskRef");
        if (!isTaskLike) return "";
        double amount = grossOf(row);
        JsonNode rel = Js.is(row, "sourceType", "release") ? find(releases, r -> eq(r, "id", row, "sourceId")) : null;
        JsonNode inv = Js.is(row, "sourceType", "invoice") ? find(docs, d -> eq(d, "id", row, "sourceId")) : null;
        JsonNode ticket = rel != null ? find(tickets, t -> eq(t, "id", rel, "ticketId"))
                : inv != null ? find(tickets, t -> eq(t, "id", inv, "ticketId"))
                : find(tickets, t -> eq(t, "ticketNumber", row, "taskRef") || eq(t, "id", row, "sourceId"));
        if (ticket == null) return Js.is(row, "sourceType", "release") || Js.is(row, "sourceType", "invoice") ? "The task for this payment was not found" : "";
        List<JsonNode> others = filter(liveDebits(ledger), l -> !eq(l, "id", row, "id"));
        if (Js.is(row, "sourceType", "release")) {
            if (rel == null) return "This release no longer exists";
            if (!Js.is(rel, "status", "Approved")) return Js.is(rel, "status", "Paid") ? "This release is already paid" : "This release is " + lower(jsString(rel, "status")) + ", so it cannot be paid";
            double already = 0;
            for (JsonNode l : others) if (eq(l, "sourceId", rel, "id")) already += grossOf(l);
            if (already > TOLERANCE) return "A payment of " + money(already) + " is already recorded against this release";
            if (amount > num(rel, "amount") + TOLERANCE) return "The release is for " + money(num(rel, "amount")) + " - the payment cannot be more (" + money(amount) + ")";
            if (Js.is(ticket, "status", "Cancelled")) return "This task is cancelled";
            Money m = taskMoney(ticket, docs, releases, ledger, keyOf(rel, "id"));
            if (m.cap() > 0 && m.direct() + m.releasedLive() + num(rel, "amount") > m.cap() + TOLERANCE)
                return money(m.direct()) + " was already paid straight against this task and " + money(m.releasedLive()) + " released, so paying this release would take it past the " + m.basis().toLowerCase() + " amount of " + money(m.cap()) + ". Cancel the release instead.";
            return "";
        }
        if (Js.is(ticket, "status", "Cancelled")) return "This task is cancelled - reverse or cancel its money first";
        Money m = taskMoney(ticket, docs, releases, ledger, NO_EXCEPT);
        if (inv != null) {
            if (!isApproved(inv)) return "This invoice is not fully approved yet";
            double onInv = 0;
            for (JsonNode l : others) if (eq(l, "sourceId", inv, "id")) onInv += grossOf(l);
            if (onInv + amount > num(inv, "amount") + TOLERANCE)
                return "This invoice is " + money(num(inv, "amount")) + " and " + money(onInv) + " is already paid on it - only " + money(Math.max(0, num(inv, "amount") - onInv)) + " is left";
        }
        if (m.cap() <= 0) return "Nothing is approved for this task yet (no approved quotation or invoice), so it cannot be paid";
        if (m.committed() + amount > m.cap() + TOLERANCE)
            return "Only " + money(m.remaining()) + " of " + money(m.cap()) + " (the " + m.basis().toLowerCase() + " amount) is left - " + money(m.committed()) + " is already released or paid";
        return "";
    }

    /** Why a reversal is not allowed: "" when it is. */
    static String reversalBlock(JsonNode orig, JsonNode reversalRow, List<JsonNode> ledger) {
        if (orig == null) return "The payment to reverse was not found";
        if (!Js.is(orig, "type", "Debit")) return "Only a payment (debit) can be reversed";
        if (reversedIds(ledger).contains(keyOf(orig, "id"))) return "This payment has already been reversed";
        if (Js.is(orig, "reconStatus", "Matched")) return "This payment is matched to a bank statement line, so the money really left. Record the refund when it arrives, or undo the match first.";
        if (trim(Js.str(reversalRow, "reason")).isEmpty()) return "Say why the payment is being reversed";
        if (Math.abs(num(reversalRow, "amount") - num(orig, "amount")) > TOLERANCE) return "A reversal must be for the full amount of the payment";
        if (!eq(reversalRow, "account", orig, "account")) return "A reversal goes back to the same bank account";
        return "";
    }

    // ---- the rules, applied to every write ----------------------------------------------------------------------------------------

    /** Lazily read raw rows of a collection (the same list is not read twice in one check). */
    public static final class Lists {
        private final Function<String, List<JsonNode>> source;
        private final java.util.Map<String, List<JsonNode>> seen = new java.util.HashMap<>();
        public Lists(Function<String, List<JsonNode>> source) { this.source = source; }
        List<JsonNode> of(String collection) { return seen.computeIfAbsent(collection, source); }
    }

    /** @param op create | update | delete @return the reason to refuse, or "" when the write may go ahead */
    public static String preWrite(String collection, JsonNode record, JsonNode old, String op, Lists list) {
        if (!covers(collection)) return "";
        switch (collection) {
            case "releases": return releases(record, old, op, list);
            case "ledger": return ledger(record, old, op, list);
            case "quotations": return quotations(record, old, op, list);
            default: return tickets(record, old, list);
        }
    }

    private static String releases(JsonNode record, JsonNode old, String op, Lists list) {
        if ("delete".equals(op) || !Js.truthy(record, "ticketId")) return "";   // cultural releases have their own cap (expense amount)
        List<JsonNode> tickets = list.of("tickets"), docs = list.of("quotations"), releases = list.of("releases"), ledger = list.of("ledger");
        JsonNode ticket = find(tickets, t -> eq(t, "id", record, "ticketId"));
        Money m = taskMoney(ticket == null ? JsonNodeEmpty.OBJECT : ticket, docs, releases, ledger, Js.has(record, "id") ? keyOf(record, "id") : NO_EXCEPT);   // an undefined id falls back to the '' default
        String st = Js.text(record, "status"), was = Js.text(old, "status");
        if (old == null || ("Approved".equals(st) && !"Approved".equals(was)) || ("Waiting approval".equals(st) && "Rejected".equals(was))) return releaseBlock(ticket, m, num(record, "amount"));
        if ("Paid".equals(st) && !"Paid".equals(was)) {
            double paid = 0;
            for (JsonNode l : liveDebits(ledger)) if (eq(l, "sourceId", record, "id")) paid += grossOf(l);
            return paid + TOLERANCE >= num(record, "amount") ? "" : "A release becomes Paid only when its payment is recorded in full (Billing → Payments)";
        }
        if ("Cancelled".equals(st) && !"Cancelled".equals(was)) {
            if (!("Waiting approval".equals(was) || "Approved".equals(was))) return "Only a release that is not yet paid can be cancelled - reverse its payment first";
            if (trim(Js.str(record, "cancelReason")).isEmpty()) return "Say why the release is cancelled";
            return anyLive(ledger, record) ? "A payment is recorded against this release - reverse it first" : "";
        }
        if ("Approved".equals(st) && "Paid".equals(was)) return anyLive(ledger, record) ? "This release still has a payment recorded - reverse the payment first" : "";
        return "";
    }

    private static boolean anyLive(List<JsonNode> ledger, JsonNode record) {
        for (JsonNode l : liveDebits(ledger)) if (eq(l, "sourceId", record, "id")) return true;
        return false;
    }

    private static boolean taskLike(JsonNode r) {
        return r != null && Js.is(r, "type", "Debit") && !Js.truthy(r, "internal") && (Js.truthy(r, "taskRef") || Js.is(r, "sourceType", "release") || Js.is(r, "sourceType", "invoice") || Js.is(r, "sourceType", "task"));
    }

    private static String ledger(JsonNode record, JsonNode old, String op, Lists list) {
        List<JsonNode> tickets = list.of("tickets"), docs = list.of("quotations"), releases = list.of("releases"), ledger = list.of("ledger");
        if ("delete".equals(op)) {
            if (taskLike(old)) return "A recorded payment cannot be deleted. Reverse it (it stays in the history) and record it again if needed.";
            if (old != null && Js.truthy(old, "reversalOf")) return "A reversal cannot be deleted";
            return "";
        }
        if (Js.truthy(record, "reversalOf")) {
            if (old != null) return "A reversal cannot be changed";
            return reversalBlock(find(ledger, l -> eq(l, "id", record, "reversalOf")), record, ledger);
        }
        if (old == null) return paymentBlock(record, tickets, docs, releases, ledger);
        if (taskLike(old)) {
            List<String> bad = new ArrayList<>();
            for (String k : keysChanged(old, record, PAYMENT_LOCKED)) if (!(k.equals("tdsAmount") && !Js.truthy(old, k) && !Js.truthy(record, k))) bad.add(k);
            if (!bad.isEmpty()) return "A recorded payment’s amount, account and link cannot be edited. Reverse it and record it again.";
            if (Js.truthy(old, "taskRef") && !eq(record, "taskRef", old, "taskRef")) return "A payment cannot be moved to another task. Reverse it and record it again.";
        }
        if (!Js.truthy(old, "taskRef") && Js.truthy(record, "taskRef") && Js.is(record, "type", "Debit")) return paymentBlock(record, tickets, docs, releases, ledger);
        return "";
    }

    private static String quotations(JsonNode record, JsonNode old, String op, Lists list) {
        List<JsonNode> ledger = list.of("ledger");
        final String sid = old != null && Js.truthy(old, "id") ? keyOf(old, "id") : keyOf(record, "id");   // `old?.id || record?.id`
        List<JsonNode> live = filter(liveDebits(ledger), l -> keyOf(l, "sourceId").equals(sid));
        if ("delete".equals(op)) {
            if (!live.isEmpty()) return "Payments are recorded against this document - reverse them first";
            if (old != null && Js.is(old, "kind", "Invoice") && isApproved(old)) return "An approved invoice cannot be deleted. Send it back for correction first.";
            if (!(old != null && Js.is(old, "kind", "Invoice"))) {
                List<JsonNode> tickets = list.of("tickets"), docs = list.of("quotations"), releases = list.of("releases");
                JsonNode t = find(tickets, x -> eq(x, "id", old, "ticketId"));
                if (t != null && eq(t, "selectedQuotationId", old, "id") && taskMoney(t, docs, releases, ledger, NO_EXCEPT).committed() > 0) return "Money has been released or paid against this quotation - cancel the releases / reverse the payments first";
            }
            return "";
        }
        if (old != null && Js.is(old, "kind", "Invoice") && isApproved(old) && !isApproved(record)) {
            if (!live.isEmpty()) return "Payments are recorded against this invoice - reverse them before sending it back for correction";
            if (trim(Js.str(record, "correctionNote")).isEmpty()) return "Say what is being corrected on the invoice";
        }
        return "";
    }

    private static String tickets(JsonNode record, JsonNode old, Lists list) {
        if (old == null) return "";
        boolean cancelling = Js.is(record, "status", "Cancelled") && !Js.is(old, "status", "Cancelled");
        boolean touchesMoney = cancelling
                || (ticketApproved(old) && !ticketApproved(record))
                || (num(record, "approvedAmount") < num(old, "approvedAmount") - TOLERANCE)
                || (!eq(record, "selectedQuotationId", old, "selectedQuotationId") && ticketApproved(old));
        boolean closing = Js.is(record, "status", "Closed") && !Js.is(old, "status", "Closed");
        if (!touchesMoney && !closing) return "";
        List<JsonNode> docs = list.of("quotations"), releases = list.of("releases"), ledger = list.of("ledger");
        Money m = taskMoney(old, docs, releases, ledger, NO_EXCEPT);
        if (closing) {
            long open = filter(releases, r -> eq(r, "ticketId", old, "id") && ("Waiting approval".equals(Js.text(r, "status")) || "Approved".equals(Js.text(r, "status")))).size();
            return open > 0 ? open + " release" + (open == 1 ? " is" : "s are") + " still waiting or unpaid - pay or cancel " + (open == 1 ? "it" : "them") + " before closing the task" : "";
        }
        if (Js.is(record, "status", "Cancelled")) return m.committed() > TOLERANCE ? money(m.committed()) + " is released or paid on this task - cancel the releases and reverse the payments before cancelling it" : "";
        if (num(record, "approvedAmount") < num(old, "approvedAmount") - TOLERANCE && num(record, "approvedAmount") + TOLERANCE < m.committed())
            return money(m.committed()) + " is already released or paid - the approved amount cannot go below it";
        if (m.committed() > TOLERANCE && ((ticketApproved(old) && !ticketApproved(record)) || !eq(record, "selectedQuotationId", old, "selectedQuotationId")))
            return money(m.committed()) + " is already released or paid on this approval - cancel the releases and reverse the payments before undoing it";
        return "";
    }

    /** `{}`: the stand-in for a task that was not found (taskMoney(ticket || {}, ...)). */
    private static final class JsonNodeEmpty { static final JsonNode OBJECT = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode(); }
}
