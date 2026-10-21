package com.communityos.api.billing.domain;

import java.util.Arrays;

/** State of an online payment order (State pattern): Created ─▶ Pending ─▶ Paid | Failed | Expired. Paid / Failed / Expired are final. */
public enum OrderStatus {
    CREATED("Created") { @Override public boolean canMoveTo(OrderStatus to) { return to == PENDING || to == FAILED || to == EXPIRED || to == PAID; } },
    PENDING("Pending") { @Override public boolean canMoveTo(OrderStatus to) { return to == PAID || to == FAILED || to == EXPIRED; } },
    PAID("Paid") { @Override public boolean canMoveTo(OrderStatus to) { return false; } },
    FAILED("Failed") { @Override public boolean canMoveTo(OrderStatus to) { return to == PAID; } },        // a late capture after a failed attempt still counts
    EXPIRED("Expired") { @Override public boolean canMoveTo(OrderStatus to) { return to == PAID; } };     // money that arrives is never refused

    private final String label;
    OrderStatus(String label) { this.label = label; }
    public abstract boolean canMoveTo(OrderStatus to);
    public String label() { return label; }
    public boolean isFinal() { return this == PAID; }
    public static OrderStatus of(String label) { return Arrays.stream(values()).filter((s) -> s.label.equals(label)).findFirst().orElseThrow(); }
}
