package com.communityos.api.shared.domain;

import java.util.Objects;
import java.util.UUID;

/** Typed identifiers: a UnitId can never be passed where a MembershipId is expected. */
public final class Ids {
    private Ids() {}

    public record CommunityId(UUID value) { public CommunityId { Objects.requireNonNull(value); } public static CommunityId of(String s) { return new CommunityId(UUID.fromString(s)); } @Override public String toString() { return value.toString(); } }
    public record PersonId(UUID value) { public PersonId { Objects.requireNonNull(value); } @Override public String toString() { return value.toString(); } }
    public record MembershipId(UUID value) { public MembershipId { Objects.requireNonNull(value); } @Override public String toString() { return value.toString(); } }
    public record UnitId(UUID value) { public UnitId { Objects.requireNonNull(value); } public static UnitId of(String s) { return new UnitId(UUID.fromString(s)); } @Override public String toString() { return value.toString(); } }
    public record BlockId(UUID value) { public BlockId { Objects.requireNonNull(value); } @Override public String toString() { return value.toString(); } }
    public record DueId(UUID value) { public DueId { Objects.requireNonNull(value); } public static DueId of(String s) { return new DueId(UUID.fromString(s)); } public static DueId random() { return new DueId(UUID.randomUUID()); } @Override public String toString() { return value.toString(); } }
    public record OrderId(UUID value) { public OrderId { Objects.requireNonNull(value); } public static OrderId random() { return new OrderId(UUID.randomUUID()); } @Override public String toString() { return value.toString(); } }
    public record PaymentId(UUID value) { public PaymentId { Objects.requireNonNull(value); } public static PaymentId random() { return new PaymentId(UUID.randomUUID()); } @Override public String toString() { return value.toString(); } }
}
