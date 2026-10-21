package com.communityos.api.billing.domain;

import java.util.Arrays;
import java.util.EnumSet;
import java.util.Set;

/**
 * State machine of a bill (State pattern as an enum: each state lists where it may go).
 *   Unpaid ──pay part──▶ Partly paid ──pay rest──▶ Paid
 *     │ └─pay all─────────────────────────────────▶ Paid
 *     ├─cancel (nothing paid)──▶ Cancelled
 *     └─waive──▶ Waived ◀──waive── Partly paid
 * Paid, Cancelled and Waived are final: a correction is a new bill (correction_of), never an edit of a closed one.
 */
public enum DueStatus {
    UNPAID("Unpaid") { @Override Set<DueStatus> next() { return EnumSet.of(PARTLY_PAID, PAID, CANCELLED, WAIVED); } },
    PARTLY_PAID("Partly paid") { @Override Set<DueStatus> next() { return EnumSet.of(PARTLY_PAID, PAID, WAIVED); } },
    PAID("Paid") { @Override Set<DueStatus> next() { return EnumSet.noneOf(DueStatus.class); } },
    CANCELLED("Cancelled") { @Override Set<DueStatus> next() { return EnumSet.noneOf(DueStatus.class); } },
    WAIVED("Waived") { @Override Set<DueStatus> next() { return EnumSet.noneOf(DueStatus.class); } };

    private final String label;
    DueStatus(String label) { this.label = label; }
    abstract Set<DueStatus> next();

    public String label() { return label; }
    public boolean isOpen() { return this == UNPAID || this == PARTLY_PAID; }
    public boolean canMoveTo(DueStatus to) { return next().contains(to); }
    public static DueStatus of(String label) {
        return Arrays.stream(values()).filter((s) -> s.label.equals(label)).findFirst().orElseThrow(() -> new IllegalArgumentException("unknown due status " + label));
    }
}
