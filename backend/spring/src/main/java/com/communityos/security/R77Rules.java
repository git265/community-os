package com.communityos.security;

import static com.communityos.security.Changes.changedKeys;
import static com.communityos.security.Changes.isMeta;
import static com.communityos.security.Changes.onlyKeys;
import static com.communityos.security.Perms.anyPerm;
import static com.communityos.security.Perms.gateStaff;
import static com.communityos.security.Perms.has;
import static com.communityos.security.Perms.isEC;
import static com.communityos.security.Perms.isResident;
import static com.communityos.security.Perms.isStaff;
import static com.communityos.security.Verdict.OK;
import static com.communityos.security.Verdict.deny;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;

/**
 * Round 77 write rules: tampered requests. Each method is the Java form of the matching rule in src/lib/security/authz.js (same answers, same
 * wording); RuleBookConformanceCheck replays the JavaScript decisions to prove it.
 */
final class R77Rules {
    private R77Rules() {}

    // ---- guest passes: the gate counts the uses and closes a used pass ------------------------------------------------------------
    static Verdict gatePasses(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (gateStaff(p)) return OK;
        JsonNode rec = old != null ? old : next;
        boolean mine = isResident(p) && !p.unit().isEmpty() && Js.is(rec, "unit", p.unit()) && (old == null || Js.is(next, "unit", p.unit()));
        if (!mine) return deny("A villa manages only its own guest passes");
        if (c.isDelete()) return OK;
        if (old == null && Js.number(next, "usedCount") != 0) return deny("A new pass has not been used yet");
        if (old != null && Js.number(next, "usedCount") != Js.number(old, "usedCount")) return deny("Uses of a pass are counted by the gate");
        if (Js.is(next, "status", "Used") && !Js.is(old, "status", "Used")) return deny("The gate marks a pass as used");
        if (old != null && (Js.is(old, "status", "Used") || Js.is(old, "status", "Expired")) && !Js.strictEq(Js.f(next, "status"), Js.f(old, "status"))) return deny("A used or expired pass cannot be reopened - make a new one");
        return OK;
    }
    static Verdict gateCheckpoints(WriteCall c) { return gateStaff(c.p()) ? null : deny("Only the security team sets up patrol checkpoints"); }
    static Verdict gateRounds(WriteCall c) { return gateStaff(c.p()) ? null : deny("Only the security team plans patrol rounds"); }
    static Verdict gatePulse(WriteCall c) { return gateStaff(c.p()) ? OK : deny("Only gate consoles report their heartbeat"); }

    // ---- announcements: the committee sends and removes; a member only signs as themselves -----------------------------------
    static Verdict broadcasts(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (isEC(p) || anyPerm(p, "MANAGE_NOTICE_TEMPLATES", "MANAGE_GOVERNANCE")) return OK;
        if (old == null || c.isDelete()) return deny("Only the committee can send or remove broadcasts");
        Verdict base = onlyKeys(old, next, List.of("signedBy"), "Members");
        if (!base.ok()) return base;
        List<String> a = names(Js.f(old, "signedBy")); List<String> b = names(Js.f(next, "signedBy"));
        boolean removed = a.stream().anyMatch((x) -> !b.contains(x));
        boolean other = b.stream().filter((x) -> !a.contains(x)).anyMatch((x) -> !x.equals(p.name()));
        return removed || other ? deny("You can only add your own signature") : OK;
    }
    private static List<String> names(JsonNode v) {
        String s = Js.truthy(v) ? Js.toStr(v) : "";
        List<String> out = new ArrayList<>();
        for (String x : s.split(",", -1)) { String t = Js.trim(x); if (!t.isEmpty()) out.add(t); }
        return out;
    }

    // ---- the bell -----------------------------------------------------------------------------------------------------------
    static Verdict notifications(WriteCall c) {
        JsonNode old = c.old(); JsonNode next = c.next();
        if (c.isDelete()) return deny("Notifications cannot be deleted");
        if (old == null) {
            if (Js.truthy(next, "read")) return deny("A new notification starts unread");
            if (Js.truthy(next, "link") && !Js.toStr(Js.f(next, "link")).startsWith("#/")) return deny("A notification links only to a page of this app");
            return OK;
        }
        if (!RowScopes.notificationForMe(old, c.p())) return deny("This notification is not addressed to you");
        return onlyKeys(old, next, List.of("read"), "You");
    }
    static Verdict notificationPrefs(WriteCall c) {
        Principal p = c.p();
        boolean oldMine = c.old() == null || Objects.equals(Js.text(c.old(), "userName"), p.name());
        boolean nextMine = c.isDelete() || Objects.equals(Js.text(c.next(), "userName"), p.name());
        return oldMine && nextMine ? OK : deny("You can only change your own notification choices");
    }

    // ---- the field-staff roster ---------------------------------------------------------------------------------------------
    static Verdict handymen(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old();
        if (anyPerm(p, "MANAGE_TICKETS", "MANAGE_FIELD_DUTIES")) return null;
        String trade = RowScopes.tradeOf(p);
        boolean own = old != null && (Objects.equals(Js.text(old, "name"), p.name()) || (trade != null && !trade.isEmpty() && Js.is(old, "trade", trade)));
        if (isStaff(p) && old != null && !c.isDelete() && own) return null;   // field checks follow (clockedIn only)
        return deny("Only the Facility Manager or ticket managers change the field-staff roster");
    }

    // ---- amenity settings: deleting is not a back door --------------------------------------------------------------------
    static Verdict amenitySettings(WriteCall c) {
        if (c.isDelete()) return has(c.p(), "MANAGE_AMENITIES") ? OK : deny("Requires amenities management access");
        return CommunityRules.amenitySettings(c);
    }

    // ---- forum: one vote, as yourself; the reply count moves by one -------------------------------------------------------
    static Verdict forum(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (c.isDelete()) return has(p, "MODERATE_FORUM") ? OK : deny("Only moderators can delete topics");
        if (has(p, "MODERATE_FORUM")) return OK;
        if (old == null) {
            boolean votes = false;
            for (JsonNode o : Js.list(next, "pollOptions")) if (Js.number(Js.f(o, "votes")) != 0) votes = true;
            boolean st = Js.truthy(next, "status") && !Js.is(next, "status", "Open");
            if (Js.truthy(next, "pinned") || st || Js.number(next, "replies") != 0 || lengthOf(Js.f(next, "voters")) != 0 || votes) return deny("A new topic starts open, unpinned, with no replies or votes");
            return OK;
        }
        Verdict base = onlyKeys(old, next, List.of("replies", "pollOptions", "voters"), "Members");
        if (!base.ok()) return base;
        double r0 = Js.number(old, "replies"); double r1 = Js.number(next, "replies");
        if (r1 < 0 || Math.abs(r1 - r0) > 1) return deny("The reply count follows the posts");
        if (Js.differs(orEmpty(old, "pollOptions"), orEmpty(next, "pollOptions")) || Js.differs(orEmpty(old, "voters"), orEmpty(next, "voters"))) {
            List<JsonNode> v0 = Js.list(old, "voters"); List<JsonNode> v1 = Js.list(next, "voters");
            if (v0.stream().anyMatch((x) -> x.isTextual() && x.asText().equals(p.name()))) return deny("You have already voted");
            boolean lastIsMe = !v1.isEmpty() && v1.get(v1.size() - 1).isTextual() && v1.get(v1.size() - 1).asText().equals(p.name());
            boolean prefix = true;
            for (int i = 0; i < v0.size(); i++) if (i >= v1.size() || !Js.strictEq(v1.get(i), v0.get(i))) prefix = false;
            if (v1.size() != v0.size() + 1 || !lastIsMe || !prefix) return deny("You can only add your own vote");
            List<JsonNode> o0 = Js.list(old, "pollOptions"); List<JsonNode> o1 = Js.list(next, "pollOptions");
            boolean sameLabels = o0.size() == o1.size();
            for (int i = 0; sameLabels && i < o0.size(); i++) sameLabels = !Js.differs(zeroVotes(o0.get(i)), zeroVotes(o1.get(i)));
            double sum = 0; boolean bad = false;
            for (int i = 0; i < o1.size(); i++) {
                double d = Js.number(Js.f(o1.get(i), "votes")) - (i < o0.size() ? Js.number(Js.f(o0.get(i), "votes")) : 0);
                if (d < 0 || d > 1) bad = true;
                sum += d;
            }
            if (!sameLabels || bad || sum != 1) return deny("One vote adds one to one answer");
        }
        return OK;
    }
    private static JsonNode orEmpty(JsonNode rec, String key) { JsonNode v = Js.f(rec, key); return Js.truthy(v) ? v : JsonNodeFactory.instance.arrayNode(); }
    private static int lengthOf(JsonNode v) { return v == null ? 0 : v.isArray() ? v.size() : v.isTextual() ? v.asText().length() : 0; }
    /** `{ ...o, votes: 0 }` */
    private static JsonNode zeroVotes(JsonNode o) {
        ObjectNode out = JsonNodeFactory.instance.objectNode();
        if (o != null && o.isObject()) for (Iterator<String> it = o.fieldNames(); it.hasNext(); ) { String k = it.next(); out.set(k, o.get(k)); }
        else if (o != null && o.isTextual()) { String s = o.asText(); for (int i = 0; i < s.length(); i++) out.put(String.valueOf(i), String.valueOf(s.charAt(i))); }
        out.put("votes", 0);
        return out;
    }

    // ---- a resident's new maintenance request -----------------------------------------------------------------------------
    private static final List<String> RESIDENT_TICKET_START = List.of("taskType", "scope", "status", "priority", "assignedTo", "slaDueAt", "residentRating", "createdBy", "createdByRole", "createdAt");
    static Verdict residentTicketCreate(WriteCall c) {
        Principal p = c.p(); JsonNode next = c.next(); Schema schema = c.schema();
        List<String> bad = new ArrayList<>();
        for (Iterator<String> it = next.fieldNames(); it.hasNext(); ) {
            String k = it.next();
            boolean editable = schema != null && schema.field(k).map((f) -> f.canEdit(p.roleId())).orElse(false);
            if (!isMeta(k) && !editable && !RESIDENT_TICKET_START.contains(k)) bad.add(k);
        }
        if (!bad.isEmpty()) return deny("A new request cannot set: " + String.join(", ", bad));
        if (present(next, "scope") && !(Js.is(next, "scope", "Unit") || Js.is(next, "scope", "Community"))) return deny("A request is for your unit or the community");
        if (present(next, "status") && !(Js.is(next, "status", "Open") || Js.is(next, "status", "Assigned"))) return deny("A new request starts Open");
        List<String> prio = schema == null ? null : schema.field("priority").map(Schema.Field::options).orElse(null);
        JsonNode pr = Js.f(next, "priority");
        if (present(next, "priority") && !(pr.isTextual() && pr.asText().isEmpty()) && prio != null && !(pr.isTextual() && prio.contains(pr.asText()))) return deny("Pick a priority from the list");
        for (JsonNode u : Js.list(next, "affectedUnits")) if (!(u.isTextual() && u.asText().equals(p.unit()))) return deny("You can only add your own villa");
        if (Js.number(next, "residentRating") != 0) return deny("Rate the work once it is done");
        return TicketRules.slaGuard(p, null, next, c.ctx());
    }
    private static boolean present(JsonNode rec, String key) { JsonNode v = Js.f(rec, key); return !v.isMissingNode() && !v.isNull(); }

    // ---- attendance: the clock is the server's ------------------------------------------------------------------------------
    private static final long NEAR_MS = 5 * 60 * 1000;
    /** Date.parse for the shapes the app writes (ISO date-time, or a plain date as UTC midnight); NaN otherwise. */
    static double parseDate(JsonNode v) {
        if (v == null || !v.isTextual()) return Double.NaN;
        String s = v.asText();
        try { return Instant.parse(s).toEpochMilli(); } catch (RuntimeException e) { /* try a plain date */ }
        try { return LocalDate.parse(s).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(); } catch (RuntimeException e) { return Double.NaN; }
    }
    private static boolean nearNow(JsonNode v, RuleContext ctx) { double t = parseDate(v); return !Double.isNaN(t) && Math.abs(t - ctx.clock().millis()) <= NEAR_MS; }
    private static double hoursBetween(JsonNode a, JsonNode b) {
        double h = (parseDate(b) - parseDate(a)) / 3600000;
        if (Double.isNaN(h)) return Double.NaN;
        return Math.max(0, Math.round(h * 100) / 100.0);
    }
    /** The self-service part of the attendance rule (the caller has already been checked to be clocking themselves). */
    static Verdict attendanceSelf(WriteCall c) {
        JsonNode old = c.old(); JsonNode next = c.next();
        if (old == null) {
            if (Js.truthy(next, "clockOut") || !Js.is(next, "source", "Self")) return deny("A new entry is a clock-in; clock out later");
            return nearNow(Js.f(next, "clockIn"), c.ctx()) ? OK : deny("Clock in at the current time");
        }
        if (Js.truthy(old, "clockOut")) return deny("This entry is already closed - ask your supervisor to correct it");
        List<String> ch = changedKeys(old, next);
        List<String> allowed = List.of("clockOut", "outLat", "outLng", "outAcc", "outSite", "outDist", "hours", "note");
        if (!ch.stream().allMatch(allowed::contains)) return deny("You can only clock out of your own open entry");
        if (ch.contains("clockOut") && !nearNow(Js.f(next, "clockOut"), c.ctx())) return deny("Clock out at the current time");
        JsonNode out = Js.truthy(next, "clockOut") ? Js.f(next, "clockOut") : Js.f(old, "clockOut");
        if (ch.contains("hours") && Math.abs(Js.number(next, "hours") - hoursBetween(Js.f(old, "clockIn"), out)) > 0.011) return deny("Hours are worked out from your clock-in and clock-out");
        return OK;
    }

    // ---- a villa's pledge carries only what the villa may say -------------------------------------------------------------
    static final List<String> RESIDENT_PLEDGE_KEYS = List.of("eventId", "offeringId", "unit", "status", "date", "amount", "towards", "kind", "mode", "reference", "anonymous", "note", "donor", "phone", "members", "sankalpam", "paymentClaimedAt", "receiptNo");
    static Verdict pledgeCreate(JsonNode next) {
        List<String> bad = new ArrayList<>();
        for (Iterator<String> it = next.fieldNames(); it.hasNext(); ) { String k = it.next(); if (!isMeta(k) && !RESIDENT_PLEDGE_KEYS.contains(k)) bad.add(k); }
        if (!bad.isEmpty()) return deny("A pledge cannot set: " + String.join(", ", bad));
        if (Js.truthy(next, "gatewayRef")) return deny("Online payments are recorded by the payment service");
        return Js.is(next, "status", "Pledged") && !Js.truthy(next, "receiptNo") ? OK : deny("A new pledge starts as Pledged; the committee confirms receipt");
    }
}
