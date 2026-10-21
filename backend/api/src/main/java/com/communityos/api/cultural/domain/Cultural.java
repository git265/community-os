package com.communityos.api.cultural.domain;

import com.communityos.api.approval.domain.Plan;
import com.communityos.api.shared.domain.DomainException;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/** Cultural events: donations and their receipts, event expenses and their approvals, sign-ups - the rules that need no database. */
public final class Cultural {
    private Cultural() {}
    public static final List<String> KINDS = List.of("Donation", "Sponsorship", "In-kind");
    public static final List<String> TOWARDS = List.of("General", "Idol & decoration", "Prasadam & food", "Pooja & rituals", "Cultural programmes", "Sound & lights", "Charity", "Seva offering");
    /** How money reaches the committee (the office records these; online payments arrive as prepayments). */
    public static final List<String> MODES = List.of("Cash", "Cheque", "Bank transfer", "UPI", "Card", "Net banking");
    public static final BigDecimal MAX = new BigDecimal("10000000");

    /** What the books need to know about an event. */
    public record Event(UUID id, String name, LocalDate startDate, String status, String visibility, BigDecimal finalOver, String fund, BigDecimal budget,
                        BigDecimal spent, BigDecimal historicalActual, BigDecimal creditedAmount, long version) {
        public boolean published() { return "Published".equals(visibility); }
        /** Receipt numbers of an event: initials of its name (up to 4) and the year, e.g. "GC26-0007". */
        public String receiptCode() {
            StringBuilder b = new StringBuilder();
            for (String w : name.split("\\s+")) if (!w.isEmpty() && Character.isLetter(w.charAt(0)) && b.length() < 4) b.append(Character.toUpperCase(w.charAt(0)));
            if (b.isEmpty()) b.append("EVT");
            return b + (startDate == null ? "" : String.format(Locale.ROOT, "%02d", startDate.getYear() % 100));
        }
        /** An expense above the event's "final approval over" limit (or any, without a limit) also needs a final approver. */
        public boolean needsFinal(BigDecimal amount) { return finalOver == null || finalOver.signum() <= 0 || amount.compareTo(finalOver) > 0; }
        /** What may be credited back once it is over: the budget not spent. */
        public BigDecimal unused() {
            BigDecimal actual = historicalActual != null && historicalActual.signum() > 0 ? historicalActual : spent == null ? BigDecimal.ZERO : spent;
            return (budget == null ? BigDecimal.ZERO : budget).subtract(actual).max(BigDecimal.ZERO);
        }
    }

    public static final class Donation {
        public UUID id; public String shortId; public UUID eventId; public String donor; public UUID unitId; public String unitNo; public String kind = "Donation"; public String towards = "General";
        public BigDecimal amount; public LocalDate date; public String mode; public String reference; public String status = "Pledged"; public String receiptNo; public UUID offeringId;
        public String phone; public String members; public String sankalpam; public boolean anonymous; public String note; public UUID pledgedById; public UUID receivedById;
        public String receivedBy; public Instant receivedAt; public UUID paymentId; public Instant createdAt; public long version;
        public boolean received() { return "Received".equals(status); }
        public void check() {
            rule(donor != null && !donor.isBlank(), "donor-required", "The donor's name is required");
            donor = donor.strip();
            rule(donor.length() <= 120, "donor-too-long", "Keep the donor's name short");
            rule(KINDS.contains(kind), "bad-kind", "Donation, Sponsorship or In-kind");
            rule(towards == null || TOWARDS.contains(towards), "bad-towards", "Towards: " + String.join(", ", TOWARDS));
            rule(amount != null && amount.signum() > 0, "amount-required", "Enter an amount above zero");
            rule(amount.compareTo(MAX) <= 0, "amount-too-large", "That amount is too large");
            rule(amount.scale() <= 2, "bad-amount", "Rupees and paise only");
            for (String s : new String[] {note, members, sankalpam}) rule(s == null || s.length() <= 2000, "too-long", "A note is too long");
        }
    }

    public static final class Expense {
        public UUID id; public String shortId; public UUID eventId; public String item; public String category; public String vendor; public BigDecimal amount; public BigDecimal estimate;
        public LocalDate date; public String status = "Pending approval"; public String fund; public Plan plan; public String note; public UUID raisedById; public String raisedBy;
        public String ecApproval; public String ecApprovedBy; public Instant ecApprovedAt; public String ecNote; public Boolean finalRequired;
        public String approvedBy; public Instant approvedAt; public String approvalNote; public UUID paidById; public String paidBy; public Instant paidAt; public String paidMode;
        public Instant createdAt; public long version;
        public BigDecimal value() { return amount != null && amount.signum() > 0 ? amount : estimate == null ? BigDecimal.ZERO : estimate; }
        public void check() {
            rule(item != null && !item.isBlank(), "item-required", "What is the expense for?");
            item = item.strip();
            rule(item.length() <= 200, "item-too-long", "Keep the item short");
            rule((amount != null && amount.signum() > 0) || (estimate != null && estimate.signum() > 0), "amount-required", "Enter an estimate, or the actual amount");
            rule(amount == null || amount.signum() >= 0, "bad-amount", "The amount cannot be negative");
            rule(estimate == null || estimate.signum() >= 0, "bad-amount", "The estimate cannot be negative");
            rule(value().compareTo(MAX) <= 0, "amount-too-large", "That amount is too large");
        }
        /** The plan's two slots, as the app shows them (EC approval, final approval). */
        public void mirror() {
            if (plan == null) return;
            Plan.Slots s = plan.slots();
            ecApproval = s.ec(); finalRequired = s.finalRequired();
            if (s.ecLast() != null) { ecApprovedBy = s.ecLast().name(); ecApprovedAt = s.ecLast().instant(); ecNote = s.ecLast().comment(); } else { ecApprovedBy = null; ecApprovedAt = null; ecNote = null; }
            Plan.Decision last = s.finLast() != null ? s.finLast() : s.ecLast();
            boolean done = plan.approved() || plan.rejected();
            approvedBy = done && last != null ? last.name() : null; approvedAt = done && last != null ? last.instant() : null; approvalNote = done && last != null ? last.comment() : null;
            if (!"Paid".equals(status)) status = plan.rejected() ? "Rejected" : plan.approved() ? "Approved" : "Pending approval";
        }
    }

    /** One person on a sign-up list; at a programme item with an expected head count, `people` says how many come from the household. */
    public record Signup(UUID membershipId, String name, String unit, Integer people) {}
    public static int headcount(List<Signup> list) { return list.stream().mapToInt((x) -> x.people() == null || x.people() < 1 ? 1 : x.people()).sum(); }

    static void rule(boolean ok, String code, String message) { if (!ok) throw new DomainException.RuleViolated(code, message); }
}
