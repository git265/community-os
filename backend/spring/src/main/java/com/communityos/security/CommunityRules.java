package com.communityos.security;

import static com.communityos.security.Changes.changedKeys;
import static com.communityos.security.Changes.keysOf;
import static com.communityos.security.Changes.onlyKeys;
import static com.communityos.security.Perms.anyPerm;
import static com.communityos.security.Perms.canAssetsWrite;
import static com.communityos.security.Perms.canEventWork;
import static com.communityos.security.Perms.canReports;
import static com.communityos.security.Perms.has;
import static com.communityos.security.Perms.isAdmin;
import static com.communityos.security.Perms.isEC;
import static com.communityos.security.Perms.isQuoteRole;
import static com.communityos.security.Perms.isResident;
import static com.communityos.security.Verdict.OK;
import static com.communityos.security.Verdict.deny;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Write rules for the everyday community collections: attendance, files, directory, forum, wishlist, amenities, broadcasts, settings. */
final class CommunityRules {
    private CommunityRules() {}

    private static final List<String> AMENITY_MONEY_KEYS = List.of("rate", "rateUnit", "weekendRate", "gstApplicable", "gstRate", "gstMode", "depositAmount", "cancellationRules", "minNoticeHours", "maxAdvanceDays", "price");
    private static final List<String> AMENITY_NOTIFY_KEYS = List.of("adminRecipients", "reportRecipients", "dailyReport", "dailyReportTime", "summaryReport", "reminderOn", "notifyOwner", "notifyAdmin");

    private static boolean eq(JsonNode rec, String key, String value) { return value != null && value.equals(Js.text(rec, key)); }
    private static boolean nameIs(Principal p, JsonNode rec, String key) { return rec != null && eq(rec, key, p.name()); }
    private static Verdict ifOk(boolean ok, String message) { return ok ? OK : deny(message); }

    // ---- people and work ----------------------------------------------------------------------------------------------------

    /** Staff clock themselves in and out (their own row, today, system-style fields only); managers can correct any row. */
    static Verdict attendance(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (has(p, "MANAGE_FIELD_DUTIES")) return OK;
        if (isResident(p)) return deny("Residents do not have attendance records");
        if (c.isDelete()) return deny("Only a supervisor can delete an attendance entry");
        if (!eq(next, "staffName", p.name())) return deny("You can only clock yourself in or out");
        if (old == null) return !Js.truthy(next, "clockOut") && Js.is(next, "source", "Self") ? OK : deny("A new entry is a clock-in; clock out later");
        if (Js.truthy(old, "clockOut")) return deny("This entry is already closed - ask your supervisor to correct it");
        List<String> allowed = List.of("clockOut", "outLat", "outLng", "outAcc", "outSite", "outDist", "hours", "note");
        return changedKeys(old, next).stream().allMatch(allowed::contains) ? OK : deny("You can only clock out of your own open entry");
    }

    static Verdict eventWork(WriteCall c) { return ifOk(canEventWork(c.p()), "Only the EC, Facility Manager, MEP or the event organisers can change event work"); }
    static Verdict reportSchedules(WriteCall c) { return ifOk(canReports(c.p()), "Only the EC, Facility Manager or notification managers can set up reports"); }
    static Verdict inventory(WriteCall c) { return ifOk(isQuoteRole(c.p()), "Only the EC, Facility Manager or MEP can update inventory"); }
    static Verdict inventoryRules(WriteCall c) { return ifOk(isQuoteRole(c.p()), "Only the EC, Facility Manager or MEP can change inventory import rules"); }
    static Verdict audits(WriteCall c) { return ifOk(isQuoteRole(c.p()), "Only the EC, Facility Manager or MEP can record audits"); }

    private static final String ASSET_DENY = "Only the EC, Facility Manager, MEP or the people who record meter readings can change these records";
    static Verdict assets(WriteCall c) { return ifOk(canAssetsWrite(c.p()), ASSET_DENY); }

    /** An asset's name is fixed once saved: only an admin or an EC member can rename it. */
    static Verdict equipment(WriteCall c) {
        Principal p = c.p();
        if (!canAssetsWrite(p)) return deny(ASSET_DENY);
        if (c.old() != null && !orEmpty(c.next(), "name").equals(orEmpty(c.old(), "name")) && !isEC(p) && !isAdmin(p))
            return deny("An asset's name is fixed once saved. Only an admin or an EC member can rename it");
        return OK;
    }
    private static String orEmpty(JsonNode rec, String key) { return Changes.orEmpty(rec, key); }

    static Verdict vendorComments(WriteCall c) {
        if (c.isDelete() || c.old() != null) return deny("Comments cannot be edited or deleted");
        return isQuoteRole(c.p()) || has(c.p(), "MANAGE_VENDORS") ? OK : deny("Only EC, Facility Manager, MEP or vendor managers can comment");
    }

    // ---- self-service -------------------------------------------------------------------------------------------------------

    static Verdict pollVotes(WriteCall c) {
        if (c.isDelete()) return deny("Poll votes cannot be deleted");
        return !nameIs(c.p(), c.next(), "voter") || (c.old() != null && !nameIs(c.p(), c.old(), "voter")) ? deny("You can only answer a poll as yourself") : OK;
    }

    static Verdict userProfiles(WriteCall c) {
        if (c.isDelete()) return deny("Profile details cannot be deleted");
        return !nameIs(c.p(), c.next(), "userName") || (c.old() != null && !nameIs(c.p(), c.old(), "userName")) ? deny("You can only change your own profile details") : OK;
    }

    static Verdict villaImportRules(WriteCall c) { return ifOk(isAdmin(c.p()), "Only the Super Admin can change import rules"); }
    static Verdict importProfiles(WriteCall c) { return ifOk(isAdmin(c.p()) || anyPerm(c.p(), "MANAGE_LEDGER"), "Only the Super Admin or finance editors can change import rules"); }

    /** Uploaded files are write-once; the extension and size are checked here as well as in the web app. */
    static Verdict files(WriteCall c, Constants k) {
        if (c.isDelete() || c.old() != null) return has(c.p(), "MANAGE_DOCUMENTS") ? OK : deny("Uploaded files cannot be changed or deleted");
        String name = Js.truthy(c.next(), "name") ? Js.str(c.next(), "name") : "";
        String ext = name.substring(name.lastIndexOf('.') + 1).toLowerCase();   // 'a.b.PDF' -> 'pdf'; no dot -> the whole name, as split('.').pop() does
        if (!k.allowedExtensions().contains(ext)) return deny("." + ext + " files are not allowed");
        if (Js.toNumber(Js.f(c.next(), "size")) > k.maxBytes() + 1024) return deny("File is too large");
        return OK;
    }

    // ---- directory and forum ------------------------------------------------------------------------------------------------

    private static boolean moderator(Principal p) { return isEC(p) || has(p, "MODERATE_FORUM"); }

    static Verdict serviceContacts(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        boolean mod = moderator(p);
        boolean mine = nameIs(p, old, "addedBy");
        if (c.isDelete()) return mine || mod ? OK : deny("You can only remove contacts you added");
        if (old == null) return nameIs(p, next, "addedBy") ? OK : deny("Added-by must be you");
        if (mod) return OK;
        if (!mine) return deny("You can only edit contacts you added - leave a review instead");
        if (Js.differs(Js.f(next, "status"), Js.f(old, "status")) && Js.is(next, "status", "Hidden")) return deny("Only moderators can hide a contact");
        return OK;
    }

    private static boolean ratingOk(JsonNode next) { double r = Js.toNumber(Js.f(next, "rating")); return r >= 1 && r <= 5; }

    static Verdict contactReviews(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        boolean mod = moderator(p);
        boolean mine = nameIs(p, old, "author");
        if (c.isDelete()) return mine || mod ? OK : deny("You can only delete your own review");
        if (old == null) return nameIs(p, next, "author") && ratingOk(next) ? OK : deny("Give a rating from 1 to 5 as yourself");
        if (mine || mod) return ratingOk(next) ? OK : deny("Rating must be 1 to 5");
        return deny("You can only edit your own review");
    }

    static Verdict forum(WriteCall c) {
        Principal p = c.p();
        if (c.isDelete()) return has(p, "MODERATE_FORUM") ? OK : deny("Only moderators can delete topics");
        if (c.old() == null || has(p, "MODERATE_FORUM")) return OK;
        return onlyKeys(c.old(), c.next(), List.of("replies", "pollOptions", "voters"), "Members");
    }

    static Verdict forumPosts(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        boolean mine = nameIs(p, old, "author");
        if (c.isDelete()) return mine || has(p, "MODERATE_FORUM") ? OK : deny("You can only delete your own posts");
        if (old == null) return !Js.truthy(next, "authorRoleId") || eq(next, "authorRoleId", p.roleId()) ? OK : deny("Author mismatch");
        if (mine || has(p, "MODERATE_FORUM")) return OK;
        return onlyKeys(old, next, List.of("reactions"), "Members");
    }

    private static Set<String> setOf(JsonNode rec, String key) {
        Set<String> s = new LinkedHashSet<>();
        JsonNode v = Js.f(rec, key);
        if (!Js.truthy(v)) return s;
        if (v.isArray()) for (JsonNode x : v) s.add(x.isTextual() ? x.asText() : "\u0000" + Js.stringify(x));
        return s;
    }

    /** Wishlist: the raiser edits the text while it is Submitted; any resident may toggle their own villa in `votes`; the EC manages the rest. */
    static Verdict wishes(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        boolean mgr = has(p, "MANAGE_TICKETS") || isEC(p) || isAdmin(p);
        boolean mine = nameIs(p, old, "raisedBy");
        if (c.isDelete()) return mgr || (mine && (Js.is(old, "status", "Submitted") || Js.is(old, "status", "Withdrawn"))) ? OK : deny("Only the EC, or you while the idea is still Submitted, can delete it");
        if (old == null) {
            if ("Vendor".equals(p.category())) return deny("Vendors cannot raise wishlist ideas");
            if (Js.truthy(next, "raisedBy") && !eq(next, "raisedBy", p.name())) return deny("Ideas are raised as yourself");
            if (!mgr && Js.truthy(next, "status") && !Js.is(next, "status", "Submitted")) return deny("New ideas start as Submitted");
            return OK;
        }
        if (mgr) return OK;
        List<String> changed = changedKeys(old, next);
        if (changed.stream().allMatch((k) -> k.equals("votes"))) {
            Set<String> a = setOf(old, "votes"); Set<String> b = setOf(next, "votes");
            boolean foreign = false;
            for (String x : a) if (!b.contains(x) && !x.equals(p.unit())) foreign = true;
            for (String x : b) if (!a.contains(x) && !x.equals(p.unit())) foreign = true;
            if (p.unit().isEmpty() || foreign) return deny("You can only add or remove your own villa's vote");
            String st = Js.text(old, "status");
            if ("Done".equals(st) || "Declined".equals(st) || "Withdrawn".equals(st)) return deny("Voting is closed on this idea");
            return OK;
        }
        List<String> editable = List.of("title", "description", "category", "location", "attachments", "status");
        if (mine && Js.is(old, "status", "Submitted") && changed.stream().allMatch(editable::contains)) {
            if (changed.contains("status") && !Js.is(next, "status", "Withdrawn")) return deny("You can only withdraw your idea");
            return OK;
        }
        if (mine && changed.stream().allMatch((k) -> k.equals("status")) && Js.is(next, "status", "Withdrawn")) return OK;
        return deny("Only the EC can change an idea's status or decision");
    }

    // ---- amenities and messages ---------------------------------------------------------------------------------------------

    private static List<String> changedOrAll(JsonNode old, JsonNode next) { return old != null ? changedKeys(old, next) : keysOf(next); }

    static Verdict amenityTypes(WriteCall c) {
        Principal p = c.p();
        if (c.isDelete()) return has(p, "MANAGE_AMENITIES") ? OK : deny("Requires amenities management access");
        List<String> changed = changedOrAll(c.old(), c.next());
        boolean money = changed.stream().anyMatch(AMENITY_MONEY_KEYS::contains);
        boolean rules = changed.stream().anyMatch((k) -> k.equals("rules"));
        boolean rest = changed.stream().anyMatch((k) -> !AMENITY_MONEY_KEYS.contains(k) && !k.equals("rules"));
        if (money && !has(p, "MANAGE_AMENITY_RATES")) return deny("Changing rates, GST, deposits or cancellation rules needs the \"Change amenity rates\" permission");
        if (rules && !has(p, "MANAGE_AMENITY_RULES")) return deny("Editing rules & regulations needs the \"Edit amenity rules\" permission");
        if (rest && !has(p, "MANAGE_AMENITIES")) return deny("Requires amenities management access");
        return OK;
    }

    static Verdict amenitySettings(WriteCall c) {
        Principal p = c.p();
        List<String> changed = changedOrAll(c.old(), c.next());
        boolean notif = changed.stream().anyMatch(AMENITY_NOTIFY_KEYS::contains);
        boolean money = changed.stream().anyMatch((k) -> !AMENITY_NOTIFY_KEYS.contains(k));
        if (money && !(has(p, "MANAGE_AMENITY_RATES") || has(p, "MANAGE_AMENITIES"))) return deny("Changing GST / payment / refund settings needs the \"Change amenity rates\" permission");
        if (notif && !has(p, "MANAGE_NOTIFICATIONS")) return deny("Changing who is notified and when reports go out needs the \"Edit notification templates\" permission");
        return OK;
    }

    static Verdict notificationTemplates(WriteCall c) {
        return ifOk(has(c.p(), "MANAGE_NOTIFICATIONS"), "Editing notification templates needs the \"Edit notification templates\" permission");
    }

    /** Residents create a booking for their own villa and may only ask to CANCEL it; every amount is computed by the server. */
    static Verdict amenities(WriteCall c) {
        Principal p = c.p(); JsonNode old = c.old(); JsonNode next = c.next();
        if (c.isDelete()) return deny("Bookings cannot be deleted - cancel them instead");
        if (isResident(p)) {
            if (p.unit().isEmpty() || !eq(next, "unit", p.unit())) return deny("You can only book or change bookings for your own unit");
            if (old == null) return OK;
            Verdict base = onlyKeys(old, next, List.of("_action", "cancelReason", "status", "paymentMode", "waive", "refundOverride", "refundTo"), "Residents");
            if (!base.ok()) return base;
            return Js.is(next, "_action", "cancel") ? OK : deny("Residents can only cancel their booking");
        }
        return has(p, "MANAGE_AMENITIES") || isEC(p) ? OK : deny("Requires amenities management access");
    }

    static Verdict broadcasts(WriteCall c) {
        Principal p = c.p();
        if (isEC(p) || anyPerm(p, "MANAGE_NOTICE_TEMPLATES", "MANAGE_GOVERNANCE")) return OK;
        if (c.old() == null) return deny("Only the committee can send broadcasts");
        return onlyKeys(c.old(), c.next(), List.of("signedBy", "viewed"), "Members");
    }
}
