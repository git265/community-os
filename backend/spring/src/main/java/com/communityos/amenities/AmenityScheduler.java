package com.communityos.amenities;

import static com.communityos.amenities.AmenityEngine.num;
import static com.communityos.amenities.AmenityEngine.round2;

import com.communityos.port.DocumentRepository;
import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.DayOfWeek;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * The amenity "cron": unpaid bookings are released, finished bookings completed, the day-before reminder and the daily / summary reports go out.
 * A port of runAmenityScheduler / ensureAmenityDefaults in src/lib/amenityServer.js. Safe to run as often as you like (it only does what is due), and safe on
 * two servers at once: each booking is locked and looked at again inside its own transaction, so a reminder is sent once.
 */
public class AmenityScheduler {
    /** Runs a step in one database transaction (Tx::run); tests without a database just run it. */
    public interface Atomic { <T> T run(Supplier<T> work); }

    public record Stats(int released, int completed, int reminders, boolean daily, boolean summary) {}

    private final DocumentRepository repo;
    private final AmenityNotifier notifier;
    private final AmenitySystem system;
    private final ObjectMapper json;
    private final Atomic atomic;

    public AmenityScheduler(DocumentRepository repo, AmenityNotifier notifier, AmenitySystem system, ObjectMapper json, Atomic atomic) {
        this.repo = repo; this.notifier = notifier; this.system = system; this.json = json; this.atomic = atomic != null ? atomic : new Atomic() { public <T> T run(Supplier<T> w) { return w.get(); } };
    }

    /** Communities that began before this feature (or from the empty template) get the default settings row and message templates. */
    public void ensureDefaults(String tenant) {
        atomic.run(() -> {
            List<JsonNode> settings = repo.list(tenant, "amenitySettings"), templates = repo.list(tenant, "notificationTemplates");
            if (settings.isEmpty()) {
                ObjectNode s = json.createObjectNode();
                s.put("gstin", ""); s.put("defaultGstRate", 18); s.put("receiptAccount", ""); s.put("refundMode", "Credit to unit account"); s.put("paymentDueHours", 48);
                s.put("notifyOwner", true); s.put("notifyAdmin", true); s.put("reminderOn", false); s.put("dailyReport", false); s.put("dailyReportTime", "20:00"); s.put("summaryReport", "Off");
                s.set("adminRecipients", json.createArrayNode()); s.set("reportRecipients", json.createArrayNode());
                ArrayNode roles = json.createArrayNode(); roles.add("facility_manager").add("committee_amenities"); s.set("inAppRoleIds", roles);
                system.put(tenant, "amenitySettings", s, null);
            }
            if (templates.isEmpty()) for (ObjectNode t : AmenityTemplates.defaultTemplates()) { t.remove("id"); system.put(tenant, "notificationTemplates", t, null); }
            return null;
        });
    }

    /** @return when a stored date-time means (ms since 1970), NaN when it is not one this code reads (a stamp written by the system always is) */
    public static double millis(JsonNode n) {
        if (n == null || n.isMissingNode() || n.isNull()) return Double.NaN;
        if (n.isNumber()) return n.asDouble();
        if (!n.isTextual()) return Double.NaN;
        String s = n.asText().trim();
        try { return Instant.parse(s).toEpochMilli(); } catch (RuntimeException e) { /* fall through */ }
        try { return LocalDate.parse(s).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(); } catch (RuntimeException e) { return Double.NaN; }
    }

    private static boolean before(JsonNode a, String b) { return a.isTextual() && a.asText().compareTo(b) < 0; }

    private ObjectNode stamp(String tenant, JsonNode row, ObjectNode patch, String nowIso) {
        ObjectNode next = row.deepCopy();
        patch.fields().forEachRemaining(e -> next.set(e.getKey(), e.getValue()));
        JsonNode v = Js.f(row, "recVersion");
        if (v.isNumber() || !Js.truthy(v)) next.set("recVersion", num((Js.truthy(v) ? v.asDouble() : 0) + 1)); else next.put("recVersion", Js.toStr(v) + "1");
        next.put("lastUpdatedAt", nowIso).put("lastUpdatedBy", AmenitySystem.SYSTEM);
        repo.upsert(tenant, "amenities", Js.toStr(row.get("id")), next);
        return next;
    }

    /** One pass over one community. */
    public Stats run(String tenant, ZoneId zone) {
        ensureDefaults(tenant);
        Instant now = system.clock().instant();
        String nowIso = system.now();
        JsonNode settings = repo.list(tenant, "amenitySettings").stream().findFirst().orElse(json.createObjectNode());
        List<JsonNode> bookings = repo.list(tenant, "amenities");
        String t0 = nowIso.substring(0, 10);
        int released = 0, completed = 0, reminders = 0;
        boolean daily = false, summary = false;

        // 1. unpaid cash / cheque bookings are released after the grace period
        double dueH = Js.toNumber(Js.f(settings, "paymentDueHours")); if (Double.isNaN(dueH)) dueH = 0;
        if (dueH > 0) {
            final double hours = dueH;
            for (JsonNode b : bookings) {
                if (!(Js.is(b, "status", "Pending payment") && Js.is(b, "paymentStatus", "Pending"))) continue;
                if (!(now.toEpochMilli() - millis(Js.f(b, "recordCreatedAt")) > hours * 3600000)) continue;
                boolean did = atomic.run(() -> {
                    JsonNode fresh = lockAndGet(tenant, b);
                    if (fresh == null || !(Js.is(fresh, "status", "Pending payment") && Js.is(fresh, "paymentStatus", "Pending"))) return false;
                    ObjectNode patch = json.createObjectNode();
                    patch.put("status", "Cancelled"); patch.put("paymentStatus", "Cancelled"); patch.put("depositStatus", "None"); patch.put("cancelledAt", nowIso); patch.put("cancelledBy", AmenitySystem.SYSTEM);
                    patch.put("cancelReason", "Payment not received within " + Js.numberToString(hours) + " hours"); patch.put("refundStatus", "None"); patch.put("refundAmount", 0);
                    ObjectNode next = stamp(tenant, fresh, patch, nowIso);
                    if (Js.toNumber(Js.f(fresh, "creditApplied")) > 0) {
                        ObjectNode c = json.createObjectNode();
                        put(c, "unit", Js.f(fresh, "unit")); c.put("type", "Credit"); c.set("amount", num(round2(Js.f(fresh, "creditApplied")))); c.put("reason", "Booking " + Js.toStr(Js.f(fresh, "shortId")) + " released unpaid - credit given back");
                        put(c, "bookingId", Js.f(fresh, "id")); put(c, "bookingNo", Js.f(fresh, "shortId")); c.put("date", t0);
                        system.put(tenant, "unitCredits", c, null);
                    }
                    notifier.notify(tenant, "payment_expired", next, settings, "", null);
                    return true;
                });
                if (did) released++;
            }
        }
        // 2. confirmed bookings whose day has passed become Completed (so the deposit can be settled)
        for (JsonNode b : bookings) {
            if (!(Js.is(b, "status", "Confirmed") && before(Js.f(b, "date"), t0))) continue;
            boolean did = atomic.run(() -> {
                JsonNode fresh = lockAndGet(tenant, b);
                if (fresh == null || !Js.is(fresh, "status", "Confirmed")) return false;
                stamp(tenant, fresh, json.createObjectNode().put("status", "Completed"), nowIso);
                return true;
            });
            if (did) completed++;
        }
        // 3. the day-before reminder to the owner
        if (Js.truthy(settings, "reminderOn")) {
            String tmr = AmenityReports.addDays(t0, 1, zone);
            for (JsonNode b : bookings) {
                if (!(Js.is(b, "status", "Confirmed") && Js.is(b, "date", tmr) && !Js.truthy(b, "reminderSent"))) continue;
                boolean did = atomic.run(() -> {
                    JsonNode fresh = lockAndGet(tenant, b);
                    if (fresh == null || !(Js.is(fresh, "status", "Confirmed") && !Js.truthy(fresh, "reminderSent"))) return false;
                    ObjectNode next = stamp(tenant, fresh, json.createObjectNode().put("reminderSent", true), nowIso);
                    notifier.notify(tenant, "reminder", next, settings, "", null);
                    return true;
                });
                if (did) reminders++;
            }
        }
        // 4. reports: once a day, from the set time on
        ZonedDateTime local = now.atZone(zone);
        String hhmm = String.format("%02d:%02d", local.getHour(), local.getMinute());
        Optional<JsonNode> first = repo.list(tenant, "amenitySettings").stream().findFirst();
        if (first.isPresent()) {
            boolean[] did = atomic.run(() -> {
                repo.lock(tenant, "amenitySettings", List.of(Js.toStr(first.get().get("id"))));
                JsonNode runs = repo.get(tenant, "amenitySettings", Js.toStr(first.get().get("id"))).orElse(first.get());
                ObjectNode patch = null;
                boolean d = false, s = false;
                if (Js.truthy(settings, "dailyReport") && !Js.strictEq(Js.f(runs, "lastDailyRun"), json.getNodeFactory().textNode(t0)) && atOrAfter(hhmm, Js.f(settings, "dailyReportTime"))) {
                    notifier.sendReport(tenant, "daily", zone);
                    patch = json.createObjectNode(); patch.put("lastDailyRun", t0); d = true;
                }
                boolean due = (Js.is(settings, "summaryReport", "Weekly") && local.getDayOfWeek() == DayOfWeek.MONDAY) || (Js.is(settings, "summaryReport", "Monthly") && local.getDayOfMonth() == 1);
                if (due && !Js.strictEq(Js.f(runs, "lastSummaryRun"), json.getNodeFactory().textNode(t0)) && atOrAfter(hhmm, Js.f(settings, "dailyReportTime"))) {
                    notifier.sendReport(tenant, "summary", zone);
                    if (patch == null) patch = json.createObjectNode();
                    patch.put("lastSummaryRun", t0); s = true;
                }
                if (patch != null) { ObjectNode merged = runs.deepCopy(); merged.setAll(patch); repo.upsert(tenant, "amenitySettings", Js.toStr(runs.get("id")), merged); }
                return new boolean[] {d, s};
            });
            daily = did[0]; summary = did[1];
        }
        return new Stats(released, completed, reminders, daily, summary);
    }

    /** `hhmm >= (setting || '20:00')`: two texts compare as text; anything else never (a number against a time is NaN). */
    private static boolean atOrAfter(String hhmm, JsonNode setting) {
        if (!Js.truthy(setting)) return hhmm.compareTo("20:00") >= 0;
        return setting.isTextual() && hhmm.compareTo(setting.asText()) >= 0;
    }

    private JsonNode lockAndGet(String tenant, JsonNode b) {
        if (!Js.truthy(b, "id")) return null;
        String id = Js.toStr(b.get("id"));
        repo.lock(tenant, "amenities", List.of(id));
        return repo.get(tenant, "amenities", id).orElse(null);
    }

    private static void put(ObjectNode o, String k, JsonNode v) { if (v != null && !v.isMissingNode()) o.set(k, v); }

    /** The tenants this pass should look at: every community (not the platform). */
    public List<String> tenants() { List<String> out = new ArrayList<>(); for (String t : repo.tenants()) if (!"platform".equals(t)) out.add(t); return out; }
}
