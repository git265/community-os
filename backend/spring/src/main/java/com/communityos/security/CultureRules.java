package com.communityos.security;

import static com.communityos.security.Changes.changedKeys;
import static com.communityos.security.Changes.onlyKeys;
import static com.communityos.security.Perms.anyPerm;
import static com.communityos.security.Perms.canCultural;
import static com.communityos.security.Perms.canCulturalEvents;
import static com.communityos.security.Perms.isResident;
import static com.communityos.security.Perms.isSecondApprover;
import static com.communityos.security.Verdict.OK;
import static com.communityos.security.Verdict.deny;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.function.Function;

/** Write rules for festivals and cultural events: events, programmes, volunteer sign-ups, offerings, donations, photos. */
final class CultureRules {
    private CultureRules() {}

    private static boolean unitIs(JsonNode r, String unit) { String u = Js.text(r, "unit"); return u != null && u.equals(unit); }

    /** A resident may add or remove only THEIR OWN entry in a sign-up list ({name, unit, phone}) and cannot exceed `limit` (0 = no limit). */
    static Verdict selfSignupOnly(Principal p, List<JsonNode> oldList, List<JsonNode> newList, double limit) {
        java.util.function.Function<List<JsonNode>, String> others = (l) -> {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (JsonNode x : l) { if (p.name().equals(Js.text(x, "name"))) continue; if (!first) sb.append(','); first = false; sb.append(Js.stringify(x)); }
            return sb.append(']').toString();
        };
        if (!others.apply(oldList).equals(others.apply(newList))) return deny("You can only add or remove your own name");
        List<JsonNode> mine = newList.stream().filter((x) -> p.name().equals(Js.text(x, "name"))).toList();
        if (mine.size() > 1 || mine.stream().anyMatch((x) -> !p.unit().equals(Js.text(x, "unit")))) return deny("One sign-up per person, for your own villa");
        boolean counted = newList.stream().anyMatch((x) -> !isNullish(Js.f(x, "people"))) || oldList.stream().anyMatch((x) -> !isNullish(Js.f(x, "people")));
        Function<List<JsonNode>, Double> used = (l) -> {
            if (!counted) return (double) l.size();
            double s = 0;
            for (JsonNode x : l) { double n = Js.number(x, "people"); s += Math.max(1, Math.min(20, n == 0 ? 1 : n)); }   // people, when the sign-up carries a count
            return s;
        };
        if (limit > 0 && used.apply(newList) > limit && used.apply(newList) > used.apply(oldList)) return deny("This is already full");
        return OK;
    }
    private static boolean isNullish(JsonNode n) { return n.isMissingNode() || n.isNull(); }

    static Rule signupGuard(String listKey, String limitKey) {
        return (c) -> {
            Principal p = c.p();
            if (canCulturalEvents(p)) return OK;
            if (!isResident(p) || c.isDelete() || c.old() == null) return deny("Requires permission: MANAGE_CULTURAL");
            Verdict base = onlyKeys(c.old(), c.next(), List.of(listKey), "Residents");
            if (!base.ok()) return base;
            double limit = Js.number(c.old(), limitKey);
            return selfSignupOnly(p, Js.list(c.old(), listKey), Js.list(c.next(), listKey), limit);
        };
    }

    /** A resident may only reserve a free fixed slot for their own villa, or release their own reservation. */
    static Verdict offerings(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (canCulturalEvents(p)) return OK;
        if (!isResident(p) || c.isDelete() || old == null) return deny("Requires permission: MANAGE_CULTURAL");
        Verdict base = onlyKeys(old, next, List.of("reservedBy", "reservedUnit", "reservedAt", "donationId"), "Residents");
        if (!base.ok()) return base;
        if (!Js.is(old, "kind", "Fixed slot")) return deny("This offering is a community pool - pledge any amount instead of reserving it");
        if (!Js.truthy(old, "reservedUnit")) return Js.text(next, "reservedUnit") != null && Js.text(next, "reservedUnit").equals(p.unit()) && !p.unit().isEmpty() ? OK : deny("Reserve a slot for your own villa");
        if (Js.str(old, "reservedUnit").equals(p.unit()) && (!Js.truthy(next, "reservedUnit") || Js.is(next, "reservedUnit", p.unit()))) return OK;   // releasing / completing their own reservation
        return deny("This slot is already reserved");
    }

    static Verdict donations(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (canCultural(p)) return OK;
        if (!isResident(p) || p.unit().isEmpty()) return deny("Requires permission: MANAGE_CULTURAL or MANAGE_LEDGER");
        if (!unitIs(next, p.unit())) return deny("You can only pledge for your own villa");
        if (c.isDelete()) return Js.is(old, "status", "Pledged") ? OK : deny("A confirmed donation cannot be withdrawn - contact the committee");
        if (old == null) return Js.is(next, "status", "Pledged") && !Js.truthy(next, "receiptNo") ? OK : deny("A new pledge starts as Pledged; the committee confirms receipt");
        if (!Js.is(old, "status", "Pledged")) return deny("This donation is already confirmed and cannot be changed");
        return onlyKeys(old, next, List.of("amount", "towards", "kind", "mode", "reference", "anonymous", "note", "donor", "phone", "members", "sankalpam", "paymentClaimedAt"), "Residents");
    }

    /** Event photos: the committee manages all; anyone else adds their own and edits or removes only what they uploaded. */
    static Verdict photos(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (canCulturalEvents(p)) return OK;
        if (p.role() != null && "Vendor".equals(p.role().category())) return deny("Vendors cannot add event photos");
        if (old == null) return p.name().equals(Js.text(next, "uploadedBy")) ? OK : deny("Photos are added in your own name");
        if (!p.name().equals(Js.text(old, "uploadedBy"))) return deny("You can change or remove only photos you uploaded");
        if (c.isDelete()) return OK;
        return onlyKeys(old, next, List.of("caption", "takenOn"), "Uploaders");
    }

    /** Cultural events: the committee manages them; crediting the unused budget back to the fund is the final approvers' call. */
    static Verdict events(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        List<String> credit = List.of("creditedAmount", "creditedAt", "creditedBy", "creditNote");
        List<String> ch = changedKeys(old, next);
        if (ch.stream().anyMatch(credit::contains)) {
            if (!isSecondApprover(p, c.ctx())) return deny("Only the Treasurer or the final approvers can credit unused budget back to the fund");
            if (!Js.is(old, "status", "Completed") && !Js.is(next, "status", "Completed")) return deny("Credit the unused budget once the event is completed");
            JsonNode ha = Js.f(next, "historicalActual");
            double actual = !isNullish(ha) && !(ha.isTextual() && ha.asText().isEmpty()) ? Js.toNumber(ha) : Js.number(next, "spent");
            double saving = Math.max(0, Js.number(next, "budget") - actual);
            if (Js.toNumber(Js.f(next, "creditedAmount")) > saving + 0.5) return deny("The credit cannot be more than the unused budget");
            if (!(actual > 0)) return deny("Enter the actual spend before crediting the unused budget");
            if (ch.stream().anyMatch((k) -> !credit.contains(k) && !List.of("recordUpdatedAt", "lastUpdatedBy").contains(k))) return deny("Credit the budget on its own, without changing other details");
            return OK;
        }
        return anyPerm(p, "MANAGE_CULTURAL") ? null : deny("Requires permission: MANAGE_CULTURAL");   // null = carry on with the normal field checks
    }
}
