package com.communityos.api.approval.domain;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * A community-written approval rule: WHEN (subject, amount range, category, task type, flag) THEN these steps. Every matching rule applies; their
 * steps are joined in priority order and identical approver sets merge into one step. No rule matches -> EC, then the final approvers.
 */
public record Policy(String name, boolean active, int priority, List<String> subjects, BigDecimal minAmount, BigDecimal maxAmount,
                     List<String> categories, List<String> taskTypes, String requireFlag, List<Plan.Step> steps) {
    public static final List<String> SUBJECTS = List.of("Maintenance quotation", "Maintenance invoice", "Maintenance release", "Cultural expense", "Cultural release", "Payment request");
    public static final List<String> FLAGS = List.of("overBudget", "eventFinal");

    /** What is being approved. */
    public record Context(String subject, BigDecimal amount, String category, String taskType, List<String> flags) {}

    public Policy {
        subjects = subjects == null ? List.of() : List.copyOf(subjects); categories = categories == null ? List.of() : List.copyOf(categories);
        taskTypes = taskTypes == null ? List.of() : List.copyOf(taskTypes); steps = steps == null ? List.of() : List.copyOf(steps);
    }

    public boolean matches(Context c) {
        if (!active) return false;
        if (!subjects.isEmpty() && !subjects.contains(c.subject())) return false;
        BigDecimal a = c.amount() == null ? BigDecimal.ZERO : c.amount();
        if (minAmount != null && minAmount.signum() > 0 && a.compareTo(minAmount) < 0) return false;
        if (maxAmount != null && maxAmount.signum() > 0 && a.compareTo(maxAmount) > 0) return false;
        if (!categories.isEmpty() && !categories.contains(c.category())) return false;
        if (!taskTypes.isEmpty() && !taskTypes.contains(c.taskType())) return false;
        return requireFlag == null || requireFlag.isBlank() || (c.flags() != null && c.flags().contains(requireFlag));
    }

    public static List<Plan.Step> defaultSteps() {
        return List.of(new Plan.Step("s1", "EC", List.of(Plan.Approver.group(Plan.Group.EC_MEMBERS)), 1, true, 0, false, List.of()),
                       new Plan.Step("s2", "Final approval", List.of(Plan.Approver.group(Plan.Group.FINAL_APPROVERS)), 1, false, 0, false, List.of()));
    }

    public static Plan build(List<Policy> policies, Context c, Instant at) {
        List<Policy> used = policies.stream().filter((p) -> p.matches(c)).sorted(Comparator.comparingInt(Policy::priority).thenComparing(Policy::name)).toList();
        Map<String, Plan.Step> seen = new LinkedHashMap<>();
        List<Plan.Step> steps = new ArrayList<>();
        for (Policy p : used) for (Plan.Step st : p.steps()) {
            if (st.approvers().isEmpty()) continue;
            String key = st.approvers().stream().map((a) -> a.kind() + ":" + a.value()).sorted().collect(Collectors.joining("|"));
            Plan.Step ex = seen.get(key);
            if (ex != null) {
                Plan.Step merged = new Plan.Step(ex.id(), ex.name(), ex.approvers(), Math.max(ex.needed(), st.needed()), ex.canFinish(), ex.deadlineDays(), false, List.of());
                steps.set(steps.indexOf(ex), merged); seen.put(key, merged); continue;
            }
            Plan.Step s = new Plan.Step("s" + (steps.size() + 1), st.name() == null || st.name().isBlank() ? "Approval" : st.name(), st.approvers(), st.needed(), st.canFinish(), st.deadlineDays(), false, List.of());
            seen.put(key, s); steps.add(s);
        }
        return new Plan(1, at.toString(), used.stream().map(Policy::name).toList(), c.amount(), steps.isEmpty() ? defaultSteps() : steps, List.of());
    }
}
