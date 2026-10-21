package com.communityos.api.billing.domain;

import com.communityos.api.billing.domain.BillingEvents.PaymentOrderFailed;
import com.communityos.api.shared.domain.AggregateRoot;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import java.time.Instant;
import java.util.List;

/** An online payment started by a member: priced by the server from the bills it covers, then handed to the provider. */
public final class PaymentOrder extends AggregateRoot {
    public record Item(DueId due, Money amount) {}

    private final OrderId id; private final CommunityId community; private String shortId; private final UnitId unit; private final MembershipId payer;
    private final Money amount; private final String currency; private OrderStatus status; private final String provider; private String providerOrderRef;
    private final String idempotencyKey; private final Instant expiresAt; private Instant paidAt; private String failureReason; private final List<Item> items;

    public PaymentOrder(OrderId id, CommunityId community, String shortId, UnitId unit, MembershipId payer, Money amount, String currency, OrderStatus status, String provider,
                        String providerOrderRef, String idempotencyKey, Instant expiresAt, Instant paidAt, String failureReason, List<Item> items, long version) {
        this.id = id; this.community = community; this.shortId = shortId; this.unit = unit; this.payer = payer; this.amount = amount; this.currency = currency;
        this.status = status; this.provider = provider; this.providerOrderRef = providerOrderRef; this.idempotencyKey = idempotencyKey; this.expiresAt = expiresAt;
        this.paidAt = paidAt; this.failureReason = failureReason; this.items = List.copyOf(items); this.version = version;
    }

    /** Factory: the amount is the sum of what is still owed on each bill at this moment. */
    public static PaymentOrder price(CommunityId community, UnitId unit, MembershipId payer, List<Due> dues, String currency, String provider, String idempotencyKey, Instant expiresAt) {
        if (dues.isEmpty()) throw new DomainException.RuleViolated("nothing-to-pay", "Choose at least one bill");
        List<Item> items = dues.stream().map((d) -> {
            if (!d.status().isOpen()) throw new DomainException.RuleViolated("due-closed", "Bill " + d.shortId() + " is " + d.status().label());
            if (!d.unit().equals(unit)) throw new DomainException.RuleViolated("mixed-units", "Pay the bills of one unit at a time");
            return new Item(d.id(), d.outstanding());
        }).toList();
        Money total = items.stream().map(Item::amount).reduce(Money.ZERO, Money::plus);
        if (!total.isPositive()) throw new DomainException.RuleViolated("nothing-to-pay", "Nothing is owed on these bills");
        return new PaymentOrder(OrderId.random(), community, null, unit, payer, total, currency, OrderStatus.CREATED, provider, null, idempotencyKey, expiresAt, null, null, items, 0);
    }

    public void handedToProvider(String providerOrderRef) { move(OrderStatus.PENDING); this.providerOrderRef = providerOrderRef; }
    public void paid(Instant at) { if (status == OrderStatus.PAID) return; move(OrderStatus.PAID); paidAt = at; }
    public void failed(String reason, Instant at) {
        if (status == OrderStatus.FAILED || status == OrderStatus.PAID) return;
        move(OrderStatus.FAILED); failureReason = reason == null ? "failed" : reason.substring(0, Math.min(200, reason.length()));
        raise(new PaymentOrderFailed(id, community, unit, failureReason, at));
    }
    public boolean expireIfDue(Instant now) {
        if ((status == OrderStatus.CREATED || status == OrderStatus.PENDING) && !now.isBefore(expiresAt)) { move(OrderStatus.EXPIRED); return true; }
        return false;
    }
    /** Set by the repository after insert (the database gives the number). */
    public void numbered(String shortId) { this.shortId = shortId; }
    private void move(OrderStatus to) {
        if (!status.canMoveTo(to)) throw new DomainException.RuleViolated("order-state", "This payment is " + status.label());
        status = to;
    }

    public OrderId id() { return id; } public CommunityId community() { return community; } public String shortId() { return shortId; } public UnitId unit() { return unit; }
    public MembershipId payer() { return payer; } public Money amount() { return amount; } public String currency() { return currency; } public OrderStatus status() { return status; }
    public String provider() { return provider; } public String providerOrderRef() { return providerOrderRef; } public String idempotencyKey() { return idempotencyKey; }
    public Instant expiresAt() { return expiresAt; } public Instant paidAt() { return paidAt; } public String failureReason() { return failureReason; } public List<Item> items() { return items; }
}
