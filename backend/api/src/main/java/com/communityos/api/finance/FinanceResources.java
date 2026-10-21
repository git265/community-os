package com.communityos.api.finance;

import com.communityos.api.approval.domain.Plan;
import com.communityos.api.approval.domain.Policy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/** Finance registers served by the resource kit: approval rules and the finance settings. (The money workflows have their own services.) */
public final class FinanceResources {
    private FinanceResources() {}

    static boolean finance(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_LEDGER); }
    static boolean committeeOrStaff(Caller c) { return ResourceRules.staffOrCommittee(c); }

    // ---- approval rules ---------------------------------------------------------------------------------------------------------------------
    public record ApproverIn(String kind, String value) {}
    public record StepIn(String name, List<ApproverIn> approvers, Integer needed, Boolean canFinish, Integer deadlineDays) {}
    public record PolicyFields(String name, boolean active, BigDecimal priority, List<String> subjects, BigDecimal minAmount, BigDecimal maxAmount, List<String> categories,
                               List<String> taskTypes, String requireFlag, List<StepIn> steps) {}
    public static final Resource<PolicyFields> APPROVAL_POLICIES = new Resource<>(
        new ResourceTable<>("approvalPolicies", "finance/approval-policies", "finance.approval_policy", PolicyFields.class, "r.priority NULLS LAST, r.name"),
        new ResourceRules<>() {
            @Override public Spec<PolicyFields> readScope(Caller c) { return ResourceRules.only(FinanceResources::committeeOrStaff, c); }
            @Override public boolean mayWrite(Caller c) { return c.isSuperAdmin() || (c.isCommittee() && (c.has(Permission.MANAGE_LEDGER) || c.has(Permission.MANAGE_GOVERNANCE))); }
            @Override public PolicyFields validate(Caller c, PolicyFields f, PolicyFields old) {
                for (String s : Checks.list(f.subjects())) Checks.oneOf(s, "Subject", Policy.SUBJECTS);
                Checks.nonNegative(f.minAmount(), "From amount"); Checks.nonNegative(f.maxAmount(), "Up to amount");
                Checks.rule(f.minAmount() == null || f.maxAmount() == null || f.maxAmount().signum() == 0 || f.minAmount().compareTo(f.maxAmount()) <= 0, "bad-range", "The range starts above where it ends");
                String flag = f.requireFlag() == null || f.requireFlag().isBlank() ? null : Checks.oneOf(f.requireFlag(), "Condition", Policy.FLAGS);
                List<StepIn> steps = Checks.list(f.steps());
                Checks.rule(!steps.isEmpty(), "steps-required", "Add at least one approval step");
                List<StepIn> clean = steps.stream().map((s) -> {
                    List<ApproverIn> who = Checks.list(s.approvers());
                    Checks.rule(!who.isEmpty(), "approvers-required", "Each step needs at least one approver");
                    for (ApproverIn a : who) {
                        Checks.requiredOneOf(a.kind(), "Approver kind", List.of("group", "role", "user"));
                        if ("group".equals(a.kind())) Checks.oneOf(a.value(), "Group", List.of(Plan.Group.EC_MEMBERS.label, Plan.Group.FINAL_APPROVERS.label));
                        Checks.required(a.value(), "Approver");
                    }
                    int needed = s.needed() == null ? 1 : s.needed();
                    Checks.rule(needed >= 1 && needed <= 20, "bad-needed", "A step needs 1 to 20 approvals");
                    return new StepIn(Checks.text(s.name(), "Step name", 60), who, needed, Boolean.TRUE.equals(s.canFinish()), s.deadlineDays() == null ? 0 : Math.max(0, s.deadlineDays()));
                }).toList();
                return new PolicyFields(Checks.required(f.name(), "Name"), f.active(), f.priority() == null ? BigDecimal.valueOf(100) : f.priority(), Checks.list(f.subjects()),
                    f.minAmount(), f.maxAmount(), Checks.list(f.categories()), Checks.list(f.taskTypes()), flag, clean);
            }
            @Override public String label(PolicyFields f) { return f.name(); }
        });

    // ---- finance settings (one row per community) ----------------------------------------------------------------------------------------------
    public record SettingsFields(String onHand, BigDecimal clubhouse, BigDecimal interest, BigDecimal water, BigDecimal dg, BigDecimal emergency, BigDecimal others,
                                 boolean reminderEnabled, BigDecimal reminderEveryDays, BigDecimal reminderLeadDays, BigDecimal reminderMax, boolean lateFeeEnabled, String lateFeeKind,
                                 BigDecimal lateFeeValue, BigDecimal lateFeeGraceDays, BigDecimal lateFeeMaxMonths, String lateFeeRules, boolean lateFeeAuto, boolean blockDefaulters,
                                 BigDecimal blockOverdueDays, BigDecimal blockOverdueAmount, LocalDate lockedUntil, BigDecimal approvalLimit, boolean approvalSeparate,
                                 boolean allowOverride, boolean finalCanDecideEc, boolean invoiceSkipWithinQuote, BigDecimal invoiceTolerancePct) {}
    public static final Resource<SettingsFields> SETTINGS = new Resource<>(
        new ResourceTable<>("financeSettings", "finance/settings", "finance.finance_setting", SettingsFields.class, "r.created_at"),
        new ResourceRules<>() {
            @Override public Spec<SettingsFields> readScope(Caller c) { return ResourceRules.only(FinanceResources::committeeOrStaff, c); }
            @Override public boolean mayWrite(Caller c) { return finance(c); }
            @Override public SettingsFields validate(Caller c, SettingsFields f, SettingsFields old) {
                Checks.rule(old != null, "one-per-community", "The finance settings already exist - change them instead");
                Checks.rule(f.invoiceTolerancePct() == null || (f.invoiceTolerancePct().signum() >= 0 && f.invoiceTolerancePct().compareTo(BigDecimal.valueOf(100)) <= 0), "bad-tolerance", "The tolerance is between 0 and 100%");
                Checks.oneOf(f.lateFeeKind(), "Late fee kind", List.of("Percent per month", "Fixed per month"));
                Checks.rule(old.lockedUntil() == null || (f.lockedUntil() != null && !f.lockedUntil().isBefore(old.lockedUntil())) || c.isSuperAdmin(), "lock-back", "Only the Super Admin moves the books lock back");
                return f;
            }
            @Override public boolean deletable(SettingsFields f) { return false; }
        });

    public static List<Resource<?>> all() { return List.of(APPROVAL_POLICIES, SETTINGS); }
}
