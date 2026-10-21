package com.communityos.api.approval.domain;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * The approval plan of ONE record (a quotation, an invoice, a release, an expense): a frozen copy of the steps the community's rules asked for,
 * with every decision recorded on its step. Immutable: every change returns a new plan. Stored as JSON on the record; times are ISO-8601 text
 * (plans written by the earlier app carry plain dates), and fields this version does not know are kept out, never fatal.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Plan(Integer version, String built, List<String> rules, BigDecimal amount, List<Step> steps, List<Amendment> overrides) {
    public enum Group { EC_MEMBERS("EC members"), FINAL_APPROVERS("Final approvers"); public final String label; Group(String l) { label = l; } }

    /** Who may decide a step: a group ("EC members" / "Final approvers"), a role (code) or one member (membership id). */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Approver(String kind, String value) {
        public static Approver group(Group g) { return new Approver("group", g.label); }
        public static Approver role(String code) { return new Approver("role", code); }
    }
    /** One decision: who (membership id + name at the time), when, Approved | Rejected, and an optional comment. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Decision(String by, String name, String at, String value, String comment) {
        /** When it was decided (a plain date from the earlier app counts as the start of that day, UTC). */
        public Instant instant() {
            if (at == null || at.isBlank()) return null;
            try { return at.length() <= 10 ? java.time.LocalDate.parse(at).atStartOfDay(java.time.ZoneOffset.UTC).toInstant() : Instant.parse(at); }
            catch (java.time.format.DateTimeParseException e) { return null; }
        }
    }
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Step(String id, String name, List<Approver> approvers, Integer needed, Boolean canFinish, Integer deadlineDays, Boolean skipped, List<Decision> decisions) {
        public Step {   // boxed so that a plan written by the earlier app with fields left out still reads; never null afterwards
            approvers = approvers == null ? List.of() : List.copyOf(approvers); decisions = decisions == null ? List.of() : List.copyOf(decisions);
            needed = needed == null ? 1 : Math.max(1, needed); canFinish = Boolean.TRUE.equals(canFinish); deadlineDays = deadlineDays == null ? 0 : deadlineDays;
            skipped = Boolean.TRUE.equals(skipped);
        }
        public State state() {
            if (skipped) return State.SKIPPED;
            if (decisions.stream().anyMatch((d) -> "Rejected".equals(d.value()))) return State.REJECTED;
            long ok = decisions.stream().filter((d) -> "Approved".equals(d.value())).map(Decision::by).distinct().count();
            return ok >= needed ? State.APPROVED : State.PENDING;
        }
        public List<String> approvedBy() { return decisions.stream().filter((d) -> "Approved".equals(d.value())).map(Decision::by).distinct().toList(); }
        Step with(List<Decision> ds, boolean skip) { return new Step(id, name, approvers, needed, canFinish, deadlineDays, skip, ds); }
    }
    /** A one-time change of the undecided steps of this record, with the reason (Super Admin only). */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Amendment(String by, String at, String reason, List<String> before) {}

    public enum State { NONE, PENDING, APPROVED, REJECTED, SKIPPED }
    /** Where the plan stands: the waiting (or rejecting) step and its index. */
    public record Position(State state, int index, Step step) {}

    public Plan {
        version = version == null ? 1 : version;
        rules = rules == null ? List.of() : List.copyOf(rules); steps = steps == null ? List.of() : List.copyOf(steps); overrides = overrides == null ? List.of() : List.copyOf(overrides);
    }

    /** A plan with no steps: approved without a decision (an invoice within its approved quotation, when the community allows it). */
    public static Plan waived(Instant at, BigDecimal amount, String why) { return new Plan(1, at.toString(), List.of(why), amount, List.of(), List.of()); }

    public Position position() {
        if (steps.isEmpty()) return new Position(State.NONE, -1, null);
        for (int i = 0; i < steps.size(); i++) {
            State s = steps.get(i).state();
            if (s == State.REJECTED || s == State.PENDING) return new Position(s, i, steps.get(i));
        }
        return new Position(State.APPROVED, steps.size(), null);
    }
    /** Approved means every live step is approved; a plan without steps is approved by definition (waived). */
    public boolean approved() { State s = position().state(); return s == State.APPROVED || s == State.NONE; }
    public boolean rejected() { return position().state() == State.REJECTED; }
    public boolean anyDecision() { return steps.stream().anyMatch((s) -> !s.decisions().isEmpty()); }

    /** Record a decision on the waiting step. finish = approve and skip the later steps (only on a step that allows it). */
    public Plan decide(String by, String name, Instant at, String value, String comment, boolean finish) {
        if (!"Approved".equals(value) && !"Rejected".equals(value)) throw new IllegalArgumentException("decision must be Approved or Rejected");
        Position p = position();
        if (p.state() != State.PENDING) throw new IllegalStateException(p.state() == State.REJECTED ? "Already rejected" : "Already approved");
        List<Step> next = new ArrayList<>(steps);
        List<Decision> ds = new ArrayList<>(p.step().decisions()); ds.add(new Decision(by, name, at.toString(), value, comment == null ? "" : comment.strip()));
        Step s = p.step().with(ds, false);
        next.set(p.index(), s);
        if ("Approved".equals(value) && finish && s.canFinish() && s.state() == State.APPROVED)
            for (int j = p.index() + 1; j < next.size(); j++) next.set(j, next.get(j).with(next.get(j).decisions(), true));
        return new Plan(version, built, rules, amount, next, overrides);
    }

    /** Undo the latest decision of this person, only while nothing after it has been decided. */
    public Plan undo(String by) {
        for (int i = steps.size() - 1; i >= 0; i--) {
            Step s = steps.get(i);
            if (s.decisions().isEmpty()) continue;
            int idx = -1;
            for (int k = s.decisions().size() - 1; k >= 0; k--) if (s.decisions().get(k).by().equals(by)) { idx = k; break; }
            if (idx < 0) throw new IllegalStateException("Only the person who decided can undo it");
            List<Decision> ds = new ArrayList<>(s.decisions()); ds.remove(idx);
            List<Step> next = new ArrayList<>(steps);
            next.set(i, s.with(ds, false));
            for (int j = i + 1; j < next.size(); j++) next.set(j, next.get(j).with(next.get(j).decisions(), false));
            return new Plan(version, built, rules, amount, next, overrides);
        }
        throw new IllegalStateException("Nothing to undo");
    }

    /** Replace the steps nobody has decided yet (a one-time change for this record), keeping the decided ones exactly as they are. */
    public Plan override(List<Step> newSteps, String reason, String by, Instant at) {
        if (reason == null || reason.isBlank()) throw new IllegalArgumentException("Give a reason for changing the approvals");
        int keep = 0;
        while (keep < steps.size() && !steps.get(keep).decisions().isEmpty()) keep++;
        for (int i = keep; i < steps.size(); i++) if (!steps.get(i).decisions().isEmpty()) throw new IllegalArgumentException("Only steps that have not been decided yet can be changed");
        List<Step> next = new ArrayList<>(steps.subList(0, keep));
        for (Step s : newSteps) if (!s.approvers().isEmpty()) next.add(new Step("s" + (next.size() + 1), s.name() == null || s.name().isBlank() ? "Approval" : s.name(), s.approvers(), s.needed(), s.canFinish(), s.deadlineDays(), false, List.of()));
        if (next.isEmpty()) throw new IllegalArgumentException("Keep at least one approval step");
        List<Amendment> ov = new ArrayList<>(overrides);
        ov.add(new Amendment(by, at.toString(), reason.strip(), steps.subList(keep, steps.size()).stream().map(Step::name).toList()));
        return new Plan(version, built, rules, amount, next, ov);
    }

    /**
     * The two-slot summary the rest of the app reads: step 1 is the "EC" slot, every later live step together the "final" slot.
     * finalRequired is null until the EC slot is approved.
     */
    public record Slots(String ec, Decision ecLast, Boolean finalRequired, String fin, Decision finLast) {}
    public Slots slots() {
        if (steps.isEmpty()) return new Slots("Approved", null, false, "Approved", null);
        Step first = steps.get(0);
        List<Step> live = steps.subList(1, steps.size()).stream().filter((s) -> !s.skipped()).toList();
        State f = first.state();
        String ec = f == State.APPROVED ? "Approved" : f == State.REJECTED ? "Rejected" : "Pending";
        List<State> states = live.stream().map(Step::state).toList();
        String fin = live.isEmpty() ? (ec.equals("Approved") ? "Approved" : "Pending") : states.contains(State.REJECTED) ? "Rejected" : states.stream().allMatch((s) -> s == State.APPROVED) ? "Approved" : "Pending";
        return new Slots(ec, ec.equals("Pending") ? null : last(List.of(first)), ec.equals("Approved") ? !live.isEmpty() : null, fin, fin.equals("Pending") ? null : last(live));
    }
    private static Decision last(List<Step> ss) { Decision d = null; for (Step s : ss) for (Decision x : s.decisions()) d = x; return d; }
}
