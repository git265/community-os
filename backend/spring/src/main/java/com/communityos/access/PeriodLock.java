package com.communityos.access;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/** Once the books are closed up to a date, nobody can add, change or delete a payment dated on or before it (src/lib/finance/lock.js). */
public final class PeriodLock {
    private PeriodLock() {}

    private static final DateTimeFormatter DMY = DateTimeFormatter.ofPattern("dd MMM yyyy", Locale.UK);

    /** A message when this write touches a closed period, else null. `old` is the stored row (for edits and deletes). */
    public static String error(String lockedUntil, String collection, JsonNode record, JsonNode old) {
        if (lockedUntil == null || lockedUntil.isEmpty() || !"ledger".equals(collection)) return null;
        for (JsonNode r : new JsonNode[]{record, old}) {
            JsonNode d = Js.f(r, "date");
            if (!Js.truthy(d)) continue;
            String day = Js.str(d);
            day = day.length() > 10 ? day.substring(0, 10) : day;
            if (day.compareTo(lockedUntil) <= 0) {
                String shown;
                try { shown = LocalDate.parse(lockedUntil).format(DMY); } catch (RuntimeException e) { shown = lockedUntil; }
                return "The books are closed up to " + shown + ". A payment dated on or before that day cannot be added, changed or removed - ask the Treasurer to reopen the period if it is a genuine correction.";
            }
        }
        return null;
    }
}
