package com.communityos.api.maintenance.domain;

import java.util.Arrays;
import java.util.EnumSet;
import java.util.Set;

/**
 * Life of a ticket (State pattern as an enum: each state lists where it may go next).
 *   Open ─assign─▶ Assigned ─start─▶ In Progress ⇄ On Hold
 *                                         └─finish─▶ Completed ─confirm─▶ Closed
 *   Open / Assigned / In Progress / On Hold ─cancel (with a reason)─▶ Cancelled
 *   Closed / Cancelled ─reopen (EC only)─▶ Open          Completed ─not done yet─▶ In Progress
 * Who may make each move is decided by TicketRules; this only says which moves exist.
 */
public enum TicketStatus {
    OPEN("Open") { @Override Set<TicketStatus> next() { return EnumSet.of(ASSIGNED, IN_PROGRESS, ON_HOLD, CANCELLED); } },
    ASSIGNED("Assigned") { @Override Set<TicketStatus> next() { return EnumSet.of(OPEN, IN_PROGRESS, ON_HOLD, CANCELLED); } },
    IN_PROGRESS("In Progress") { @Override Set<TicketStatus> next() { return EnumSet.of(ON_HOLD, COMPLETED, CANCELLED); } },
    ON_HOLD("On Hold") { @Override Set<TicketStatus> next() { return EnumSet.of(IN_PROGRESS, COMPLETED, CANCELLED); } },
    COMPLETED("Completed") { @Override Set<TicketStatus> next() { return EnumSet.of(CLOSED, IN_PROGRESS); } },
    CLOSED("Closed") { @Override Set<TicketStatus> next() { return EnumSet.of(OPEN); } },
    CANCELLED("Cancelled") { @Override Set<TicketStatus> next() { return EnumSet.of(OPEN); } };

    private final String label;
    TicketStatus(String label) { this.label = label; }
    abstract Set<TicketStatus> next();

    public String label() { return label; }
    public boolean canMoveTo(TicketStatus to) { return next().contains(to); }
    /** Still being worked on (counts in queues, SLA can be late). */
    public boolean active() { return this == OPEN || this == ASSIGNED || this == IN_PROGRESS || this == ON_HOLD; }
    public boolean finished() { return this == CLOSED || this == CANCELLED; }
    public static TicketStatus of(String label) {
        return Arrays.stream(values()).filter((s) -> s.label.equals(label)).findFirst()
            .orElseThrow(() -> new com.communityos.api.shared.domain.DomainException.RuleViolated("bad-status", "Unknown status \"" + label + "\""));
    }
}
