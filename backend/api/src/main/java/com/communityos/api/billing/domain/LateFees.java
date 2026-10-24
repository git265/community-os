package com.communityos.api.billing.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Late fees (the same rules as the browser's lib/finance/rules.js planLateFees): each bill follows the rule set for its category, else the
 * "all other bills" rule. After the due date and the grace days, one fee a month: a percent of the bill or a fixed amount, up to the rule's
 * months (36 when unset). Paid, cancelled and waived bills earn none, and fees never earn fees.
 */
public final class LateFees {
    private LateFees() {}
    public static final String CATEGORY = "Late fee";
    public static final List<String> KINDS = List.of("Percent per month", "Fixed per month");
    public record Rule(String appliesTo, String kind, BigDecimal value, int grace, int maxMonths) {
        boolean all() { return appliesTo == null || appliesTo.isBlank() || "*".equals(appliesTo); }
    }
    public record Settings(boolean enabled, boolean auto, List<Rule> rules) {}
    /** An open bill as the planner needs it. */
    public record Bill(UUID id, String shortId, UUID unitId, String category, String status, BigDecimal total, LocalDate dueDate, LocalDate billedMonth) {}
    public record Fee(Bill bill, int no, BigDecimal amount) {}

    /** The community's rules: the per-category list, else the single older rule as the "all other bills" rule. */
    public static Settings settings(boolean enabled, boolean auto, String kind, BigDecimal value, BigDecimal grace, BigDecimal maxMonths, String rulesJson, ObjectMapper json) {
        List<Rule> rules = new ArrayList<>();
        if (rulesJson != null && !rulesJson.isBlank()) {
            try {
                for (JsonNode r : json.readTree(rulesJson)) rules.add(new Rule(text(r, "appliesTo", "*"), "Fixed per month".equals(text(r, "kind", "")) ? "Fixed per month" : "Percent per month",
                    dec(r.get("value")), Math.max(0, dec(r.get("grace")).intValue()), Math.max(0, dec(r.get("maxMonths")).intValue())));
            } catch (java.io.IOException | RuntimeException e) { rules.clear(); }
        }
        if (rules.isEmpty() && value != null && value.signum() > 0)
            rules.add(new Rule("*", "Fixed per month".equals(kind) ? "Fixed per month" : "Percent per month", value, grace == null ? 0 : Math.max(0, grace.intValue()), maxMonths == null ? 0 : Math.max(0, maxMonths.intValue())));
        return new Settings(enabled, auto, List.copyOf(rules));
    }
    /** The app names two bill types longer than their charge category codes (V10): a rule set for "Corpus fund" is the Corpus bills' rule. */
    static final java.util.Map<String, String> CATEGORY_ALIASES = java.util.Map.of("Corpus fund", "Corpus", "Special levy", "Levy");
    public static Rule ruleFor(Settings s, String category) {
        Rule hit = s.rules().stream().filter((r) -> category != null && (category.equals(r.appliesTo()) || category.equals(CATEGORY_ALIASES.get(r.appliesTo())))).findFirst().orElse(s.rules().stream().filter(Rule::all).findFirst().orElse(null));
        return hit != null && hit.value() != null && hit.value().signum() > 0 ? hit : null;
    }
    /** Fees due on `asOf` that are not charged yet (`charged` holds "billId#no"). */
    public static List<Fee> plan(List<Bill> bills, Set<String> charged, Settings s, LocalDate asOf) {
        List<Fee> out = new ArrayList<>();
        for (Bill b : bills) {
            if (List.of("Paid", "Cancelled", "Waived").contains(b.status()) || CATEGORY.equals(b.category()) || b.dueDate() == null || b.unitId() == null
                || b.total() == null || b.total().signum() <= 0) continue;
            Rule r = ruleFor(s, b.category());
            if (r == null) continue;
            LocalDate start = b.dueDate().plusDays(r.grace());
            int cap = r.maxMonths() > 0 ? Math.min(120, r.maxMonths()) : 36;
            for (int k = 1; k <= cap; k++) {
                if (!asOf.isAfter(start.plusMonths(k - 1))) break;
                if (charged.contains(b.id() + "#" + k)) continue;
                BigDecimal amount = "Fixed per month".equals(r.kind()) ? r.value().setScale(2, RoundingMode.HALF_UP)
                    : b.total().multiply(r.value()).divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP);
                if (amount.signum() > 0) out.add(new Fee(b, k, amount));
            }
        }
        return out;
    }
    private static String text(JsonNode n, String f, String d) { JsonNode v = n.get(f); return v == null || v.isNull() ? d : v.asText(); }
    private static BigDecimal dec(JsonNode n) { if (n == null || n.isNull()) return BigDecimal.ZERO; try { return new BigDecimal(n.asText()); } catch (NumberFormatException e) { return BigDecimal.ZERO; } }
}
