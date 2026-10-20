package com.communityos.amenities;

import com.communityos.security.Js;
import com.communityos.security.MoneyGuard;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

/**
 * Keeps a unit with long-overdue dues from booking an amenity. A port of defaulterBlock in src/lib/finance/rules.js (with the one row of
 * defaultersOf it needs: the unit's unpaid, overdue bills, their total and how many days the oldest has been overdue).
 */
public final class Defaulters {
    private Defaulters() {}

    /**
     * @param localToday the community's calendar date today ("2026-10-19"), as todayIso() in rules.js reads it
     * @return the message to refuse the booking with, or "" when the unit may book
     */
    public static String block(JsonNode unit, JsonNode financeSettings, List<JsonNode> dues, String localToday, ZoneId zone) {
        if (!Js.truthy(unit) || Js.toStr(unit).startsWith("Association")) return "";
        if (!Js.truthy(financeSettings, "blockDefaulters")) return "";
        List<JsonNode> overdue = new ArrayList<>();
        for (JsonNode d : dues) {
            if (!Js.strictEq(Js.f(d, "unit"), unit)) continue;
            boolean open = !Js.is(d, "status", "Paid") && !Js.is(d, "status", "Cancelled");
            JsonNode due = Js.f(d, "dueDate");
            if (open && Js.toNumber(Js.f(d, "amount")) > 0 && Js.truthy(due) && due.isTextual() && due.asText().compareTo(localToday) < 0) overdue.add(d);
        }
        if (overdue.isEmpty()) return "";
        double sum = 0;
        String oldest = overdue.get(0).get("dueDate").asText();
        for (JsonNode d : overdue) { sum += Js.toNumber(Js.f(d, "amount")); String due = d.get("dueDate").asText(); if (due.compareTo(oldest) < 0) oldest = due; }
        double amount = MoneyGuard.r2(sum);
        double days = daysBetween(oldest, localToday, zone);
        if (days >= Js.number(financeSettings, "blockOverdueDays") && amount > Js.number(financeSettings, "blockOverdueAmount"))
            return "Booking is on hold for " + Js.toStr(unit) + ": " + MoneyGuard.money(amount) + " has been overdue for " + Js.numberToString(days)
                    + " days. Please clear the dues in Billing & Finance → Dues, then book again.";
        return "";
    }

    /** `Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000)` */
    static double daysBetween(String a, String b, ZoneId zone) {
        double d = (AmenityEngine.parseLocal(b + "T00:00:00", zone) - AmenityEngine.parseLocal(a + "T00:00:00", zone)) / 86400000.0;
        return AmenityEngine.jsRound(d);
    }
}
