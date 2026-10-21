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

    // ---- the community's own money: funds, bank accounts, budgets, commitments, deposits, cash counts, statement layouts, skips, own bills --------
    static boolean reads(Caller c) { return com.communityos.api.finance.application.FinancePolicy.reader(c); }
    static <F extends Record> ResourceRules<F> books(java.util.function.BiFunction<Caller, F, F> check) {
        return new ResourceRules<>() {
            @Override public Spec<F> readScope(Caller c) { return ResourceRules.only(FinanceResources::reads, c); }
            @Override public boolean mayWrite(Caller c) { return finance(c); }
            @Override public F validate(Caller c, F f, F old) { return check.apply(c, f); }
        };
    }
    public record FundFields(String name, String purpose, boolean restricted, String kind, BigDecimal balance, BigDecimal annualBudget, BigDecimal targetBalance, String bankAccount) {}
    public static final Resource<FundFields> FUNDS = new Resource<>(new ResourceTable<>("funds", "finance/funds", "finance.fund", FundFields.class, "r.name"), books((c, f) -> {
        Checks.oneOf(f.kind(), "Kind", List.of("Operating", "Sinking", "Corpus", "Restricted"));
        Checks.nonNegative(f.annualBudget(), "Annual budget"); Checks.nonNegative(f.targetBalance(), "Target balance");
        return new FundFields(Checks.required(f.name(), "Name"), Checks.text(f.purpose(), "Purpose", 500), f.restricted() || "Restricted".equals(f.kind()), f.kind(), f.balance(), f.annualBudget(), f.targetBalance(), f.bankAccount());
    }));
    public record BankAccountFields(String name, String last4, BigDecimal balance, LocalDate asOf, String history) {}
    public static final Resource<BankAccountFields> BANK_ACCOUNTS = new Resource<>(new ResourceTable<>("bankAccounts", "finance/bank-accounts", "finance.bank_account", BankAccountFields.class, "r.name"), books((c, f) -> {
        Checks.rule(f.last4() == null || f.last4().isBlank() || f.last4().matches("\\d{4}"), "bad-last4", "Keep only the last 4 digits of the account number");
        Checks.rule(f.history() == null || f.history().length() <= 200_000, "too-long", "The balance history is too long");
        return new BankAccountFields(Checks.required(f.name(), "Name"), f.last4() == null || f.last4().isBlank() ? null : f.last4(), f.balance(), f.asOf(), f.history());
    }));
    public record BudgetLineFields(String fy, String kind, String name, BigDecimal forecast, BigDecimal revised, BigDecimal other, String heads, String notes) {}
    public static final Resource<BudgetLineFields> BUDGET_LINES = new Resource<>(new ResourceTable<>("budgetLines", "finance/budget-lines", "finance.budget_line", BudgetLineFields.class, "r.fy DESC, r.kind, r.name")
        .filterBy("fy"), books((c, f) -> {
        Checks.rule(f.fy() == null || f.fy().matches("\\d{4}(-\\d{2,4})?"), "bad-fy", "A financial year looks like 2026-27");
        Checks.requiredOneOf(f.kind(), "Kind", List.of("Income", "Expense"));
        Checks.nonNegative(f.forecast(), "Forecast"); Checks.nonNegative(f.revised(), "Revised");
        return new BudgetLineFields(f.fy(), f.kind(), Checks.required(f.name(), "Name"), f.forecast(), f.revised(), f.other(), f.heads(), Checks.text(f.notes(), "Notes", 2000));
    }));
    public record FixedExpenseFields(String name, BigDecimal avg, BigDecimal months, String vendor, String heads, String notes, String vendorService) {}
    public static final Resource<FixedExpenseFields> FIXED_EXPENSES = new Resource<>(new ResourceTable<>("fixedExpenses", "finance/fixed-expenses", "finance.fixed_expense", FixedExpenseFields.class, "r.name"), books((c, f) -> {
        Checks.nonNegative(f.avg(), "Monthly amount"); Checks.nonNegative(f.months(), "Months");
        return new FixedExpenseFields(Checks.required(f.name(), "Name"), f.avg(), f.months(), f.vendor(), f.heads(), Checks.text(f.notes(), "Notes", 2000), Checks.text(f.vendorService(), "Vendor category", 80));
    }));
    public record DepositFields(String account, String type, BigDecimal amount, BigDecimal rate, LocalDate startDate, LocalDate maturityDate, String status, String reference, String interestPayout,
                                boolean autoRenew, BigDecimal sweepLimit, BigDecimal interestEarned, BigDecimal taxDeducted, String notes) {}
    public static final Resource<DepositFields> DEPOSITS = new Resource<>(new ResourceTable<>("deposits", "finance/deposits", "finance.deposit", DepositFields.class, "r.maturity_date NULLS LAST"), books((c, f) -> {
        Checks.oneOf(f.status(), "Status", List.of("Active", "Matured", "Closed"));
        Checks.oneOf(f.interestPayout(), "Interest payout", List.of("At maturity (cumulative)", "Monthly", "Quarterly", "Half-yearly", "Yearly"));
        Checks.nonNegative(f.amount(), "Amount"); Checks.nonNegative(f.interestEarned(), "Interest"); Checks.nonNegative(f.taxDeducted(), "Tax deducted");
        Checks.rule(f.rate() == null || (f.rate().signum() >= 0 && f.rate().compareTo(BigDecimal.valueOf(30)) <= 0), "bad-rate", "An interest rate from 0 to 30%");
        Checks.rule(f.maturityDate() == null || f.startDate() == null || !f.maturityDate().isBefore(f.startDate()), "bad-dates", "It matures after it starts");
        return new DepositFields(Checks.required(f.account(), "Held with"), f.type(), f.amount(), f.rate(), f.startDate(), f.maturityDate(), f.status() == null ? "Active" : f.status(), f.reference(),
            f.interestPayout(), f.autoRenew(), f.sweepLimit(), f.interestEarned(), f.taxDeducted(), Checks.text(f.notes(), "Notes", 2000));
    }));
    /** A physical cash count: the difference is worked out by the server. */
    public record CashCountFields(LocalDate date, BigDecimal counted, BigDecimal expected, String notes) {}
    public static final Resource<CashCountFields> CASH_COUNTS = new Resource<>(new ResourceTable<>("cashCounts", "finance/cash-counts", "finance.cash_count", CashCountFields.class, "r.date DESC")
        .computed("difference", ResourceTable.Kind.MONEY, "(coalesce(r.counted, 0) - coalesce(r.expected, 0))"), books((c, f) -> {
        Checks.rule(f.date() != null, "date-required", "When was the cash counted?");
        Checks.nonNegative(f.counted(), "Counted"); Checks.nonNegative(f.expected(), "Expected");
        return new CashCountFields(f.date(), f.counted() == null ? BigDecimal.ZERO : f.counted(), f.expected() == null ? BigDecimal.ZERO : f.expected(), Checks.text(f.notes(), "Notes", 2000));
    }));
    public record ImportProfileFields(String name, String account, String sheet, BigDecimal headerRow, String dateCol, String narrationCol, String debitCol, String creditCol, String balanceCol,
                                      String partyCol, String remarksCol, String dateMode, boolean skipSweep) {}
    public static final Resource<ImportProfileFields> IMPORT_PROFILES = new Resource<>(new ResourceTable<>("importProfiles", "finance/import-profiles", "finance.import_profile", ImportProfileFields.class, "r.name"), books((c, f) -> {
        Checks.oneOf(f.dateMode(), "Dates", List.of("As in the file", "Day and month swapped by Excel", "Month first in text (MM/DD/YYYY)"));
        return new ImportProfileFields(Checks.required(f.name(), "Name"), f.account(), f.sheet(), f.headerRow(), Checks.required(f.dateCol(), "Date column"), f.narrationCol(), f.debitCol(), f.creditCol(),
            f.balanceCol(), f.partyCol(), f.remarksCol(), f.dateMode(), f.skipSweep());
    }));
    public record LedgerSkipFields(java.util.UUID sourceId, String taskRef, String label, String reason) {}
    public static final Resource<LedgerSkipFields> LEDGER_SKIPS = new Resource<>(new ResourceTable<>("ledgerSkips", "finance/ledger-skips", "finance.ledger_skip", LedgerSkipFields.class, "r.created_at DESC"), books((c, f) ->
        new LedgerSkipFields(f.sourceId(), f.taskRef(), f.label(), Checks.required(f.reason(), "Reason"))));
    public record AssocBillFields(String utility, String location, String provider, String accountNo, String period, LocalDate billDate, LocalDate dueDate, Integer quantity, BigDecimal amount,
                                  LocalDate paidOn, java.util.Map<String, Object> billFile, String notes) {}
    public static final Resource<AssocBillFields> ASSOC_BILLS = new Resource<>(new ResourceTable<>("assocBills", "finance/association-bills", "finance.association_bill", AssocBillFields.class, "r.bill_date DESC NULLS LAST"),
        new ResourceRules<>() {
            @Override public Spec<AssocBillFields> readScope(Caller c) { return ResourceRules.only(FinanceResources::reads, c); }
            @Override public boolean mayWrite(Caller c) { return finance(c) || c.hasAny(Permission.MANAGE_UTILITY_BILLING) || c.roleCodes().contains("facility_manager"); }
            @Override public AssocBillFields validate(Caller c, AssocBillFields f, AssocBillFields old) {
                Checks.nonNegative(f.amount(), "Amount"); Checks.nonNegative(f.quantity(), "Quantity");
                return new AssocBillFields(Checks.required(f.utility(), "Utility"), f.location(), f.provider(), f.accountNo(), f.period(), f.billDate(), f.dueDate(), f.quantity(), f.amount(), f.paidOn(),
                    f.billFile(), Checks.text(f.notes(), "Notes", 2000));
            }
        });
    /** The chart of accounts. The accounts the server posts to are fixed (code, kind); others may be added, renamed or switched off. */
    public record AccountFields(String code, String name, String kind, boolean isBank, boolean active) {}
    static final List<String> SYSTEM_CODES = List.of("1000", "1100", "1200", "1300", "2000", "2100", "2150", "2200", "2400", "3000", "4000", "4100", "4200", "4300", "4400", "4900", "5000", "5100");
    public static final Resource<AccountFields> ACCOUNTS = new Resource<>(new ResourceTable<>("accounts", "finance/accounts", "finance.account", AccountFields.class, "r.code"),
        new ResourceRules<>() {
            @Override public Spec<AccountFields> readScope(Caller c) { return ResourceRules.only(FinanceResources::reads, c); }
            @Override public boolean mayWrite(Caller c) { return finance(c); }
            @Override public AccountFields validate(Caller c, AccountFields f, AccountFields old) {
                String code = Checks.required(f.code(), "Code");
                Checks.rule(code.matches("\\d{4,6}"), "bad-code", "An account code is 4 to 6 digits");
                String kind = Checks.requiredOneOf(f.kind(), "Kind", List.of("Asset", "Liability", "Equity", "Income", "Expense"));
                if (old != null && SYSTEM_CODES.contains(old.code())) {
                    Checks.rule(old.code().equals(code) && old.kind().equals(kind), "system-account", "The server posts to " + old.code() + " - its code and kind stay");
                    Checks.rule(f.active(), "system-account", "The server posts to " + old.code() + " - it stays active");
                }
                return new AccountFields(code, Checks.required(f.name(), "Name"), kind, f.isBank(), f.active());
            }
            @Override public boolean deletable(AccountFields f) { return false; }
        });

    public static List<Resource<?>> all() {
        return List.of(APPROVAL_POLICIES, SETTINGS, FUNDS, BANK_ACCOUNTS, BUDGET_LINES, FIXED_EXPENSES, DEPOSITS, CASH_COUNTS, IMPORT_PROFILES, LEDGER_SKIPS, ASSOC_BILLS, ACCOUNTS);
    }
}
