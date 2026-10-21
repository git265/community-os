package com.communityos.api.maintenance.domain;

import com.communityos.api.approval.domain.Plan;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Money;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * A quotation or an invoice on a task. Its amounts are computed here from what is written on the document (base + GST); its approval is the
 * plan the community's rules built for it, and the "EC" / "final" slots are always derived from that plan, never set directly.
 */
public final class Quotation {
    public static final List<String> KINDS = List.of("Quotation", "Invoice");
    public static final List<String> GST_MODES = List.of("None", "Included", "Extra");

    public static final class State {
        public UUID id; public String shortId; public UUID ticketId; public String kind; public String vendor; public Money baseAmount; public String gstMode = "None";
        public BigDecimal gstRate; public Money gstAmount; public Money amount; public LocalDate quoteDate; public String note; public boolean selected; public boolean overBudget;
        public Plan plan; public boolean approvalWaived; public String correctionNote; public UUID createdBy; public String createdByName;
        public Instant createdAt, updatedAt; public long version;
        // the two-slot summary (stored for reports / older screens)
        public String ecApproval = "Pending"; public UUID ecApprovedBy; public Instant ecApprovedAt; public boolean finalRequired;
        public String finalApproval = "Pending"; public UUID finalApprovedBy; public Instant finalApprovedAt;
    }
    /** base = the amount as written on the document (for "Included" it already has the GST in it). */
    public record Amounts(Money base, Money gst, Money total) {
        public static Amounts of(BigDecimal written, String mode, BigDecimal rate) {
            if (written == null || written.signum() < 0) throw new DomainException.RuleViolated("bad-amount", "Enter the amount on the document");
            String m = mode == null ? "None" : mode;
            if (!GST_MODES.contains(m)) throw new DomainException.RuleViolated("bad-gst-mode", "GST is None, Included or Extra");
            BigDecimal r = rate == null ? BigDecimal.ZERO : rate;
            if (r.signum() < 0 || r.compareTo(BigDecimal.valueOf(40)) > 0) throw new DomainException.RuleViolated("bad-gst-rate", "GST rate is between 0 and 40%");
            BigDecimal w = written.setScale(2, RoundingMode.HALF_UP);
            return switch (m) {
                case "Extra" -> { BigDecimal g = w.multiply(r).divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP); yield new Amounts(new Money(w), new Money(g), new Money(w.add(g))); }
                case "Included" -> {
                    BigDecimal net = w.multiply(BigDecimal.valueOf(100)).divide(BigDecimal.valueOf(100).add(r), 2, RoundingMode.HALF_UP);
                    yield new Amounts(new Money(net), new Money(w.subtract(net)), new Money(w));
                }
                default -> new Amounts(new Money(w), Money.ZERO, new Money(w));
            };
        }
    }

    private final State s;
    public Quotation(State s) { this.s = s; }
    public State state() { return s; }
    public UUID id() { return s.id; } public String shortId() { return s.shortId; } public UUID ticketId() { return s.ticketId; } public long version() { return s.version; }
    public boolean invoice() { return "Invoice".equals(s.kind); } public boolean selected() { return s.selected; } public Money amount() { return s.amount; }
    public Plan plan() { return s.plan; }

    /** none | unselected | approved | rejected | pending-ec | pending-final (as the payment rules read it). */
    public String approvalKey() {
        if (!s.selected) return "unselected";
        if (s.approvalWaived) return "approved";
        if ("Rejected".equals(s.ecApproval) || "Rejected".equals(s.finalApproval)) return "rejected";
        if (!"Approved".equals(s.ecApproval)) return "pending-ec";
        if (!s.finalRequired) return "approved";
        return "Approved".equals(s.finalApproval) ? "approved" : "pending-final";
    }
    public boolean approved() { return "approved".equals(approvalKey()); }

    /** A new plan (a decision, an undo, a correction): the slots follow it. */
    public void plan(Plan p, boolean waived) {
        s.plan = p; s.approvalWaived = waived;
        Plan.Slots sl = p.slots();
        s.ecApproval = waived ? "Approved" : sl.ec(); s.ecApprovedBy = by(sl.ecLast()); s.ecApprovedAt = sl.ecLast() == null ? null : sl.ecLast().instant();
        s.finalRequired = !waived && Boolean.TRUE.equals(sl.finalRequired());
        s.finalApproval = waived ? "Approved" : sl.fin(); s.finalApprovedBy = by(sl.finLast()); s.finalApprovedAt = sl.finLast() == null ? null : sl.finLast().instant();
    }
    public void select(boolean on) { s.selected = on; }
    public void sendBack(String note, Plan fresh) {
        if (note == null || note.isBlank()) throw new DomainException.RuleViolated("note-required", "Say what is being corrected on the invoice");
        s.correctionNote = note.strip(); plan(fresh, false);
    }
    /** The status this document gives its task ("Pending approval", "Approved", "Rejected"). */
    public String status() {
        return switch (approvalKey()) { case "approved" -> "Approved"; case "rejected" -> "Rejected"; case "unselected" -> "Received"; default -> "Pending approval"; };
    }
    private static UUID by(Plan.Decision d) { if (d == null) return null; try { return UUID.fromString(d.by()); } catch (IllegalArgumentException e) { return null; } }
}
