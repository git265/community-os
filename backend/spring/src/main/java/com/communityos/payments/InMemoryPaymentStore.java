package com.communityos.payments;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** For the `memory` profile and unit tests. One monitor makes every method atomic, which is what the row lock gives on PostgreSQL. */
public class InMemoryPaymentStore implements PaymentStore {
    private final Map<String, PaymentOrder> orders = new LinkedHashMap<>();
    private final Set<String> events = new HashSet<>();
    private final Clock clock;

    public InMemoryPaymentStore(Clock clock) { this.clock = clock; }

    private Instant now() { return clock.instant(); }

    @Override public synchronized void insert(PaymentOrder o) {
        if (orders.containsKey(o.orderId())) throw new org.springframework.dao.DuplicateKeyException("order " + o.orderId());
        if (o.idempotencyKey() != null && orders.values().stream().anyMatch(x -> x.tenant().equals(o.tenant()) && o.idempotencyKey().equals(x.idempotencyKey())
                && List.of("Created", "Pending", "Paid").contains(x.status()))) throw new org.springframework.dao.DuplicateKeyException("key " + o.idempotencyKey());
        orders.put(o.orderId(), o);
    }
    @Override public synchronized Optional<PaymentOrder> get(String tenant, String id) { return find(id).filter(o -> o.tenant().equals(tenant)); }
    @Override public synchronized Optional<PaymentOrder> find(String id) { return Optional.ofNullable(orders.get(id)); }
    @Override public synchronized Optional<PaymentOrder> findByProviderRef(String ref) { return orders.values().stream().filter(o -> ref.equals(o.providerRef())).findFirst(); }
    @Override public synchronized Optional<PaymentOrder> lock(String tenant, String id) { return get(tenant, id); }
    @Override public synchronized Optional<PaymentOrder> lockOpenByKey(String tenant, String key) {
        return orders.values().stream().filter(o -> o.tenant().equals(tenant) && key.equals(o.idempotencyKey()) && o.open()).findFirst();
    }
    @Override public synchronized boolean paidWithKey(String tenant, String key) {
        return orders.values().stream().anyMatch(o -> o.tenant().equals(tenant) && key.equals(o.idempotencyKey()) && "Paid".equals(o.status()));
    }
    @Override public synchronized Optional<PaymentOrder> unusedPaidBooking(String tenant, String unit, BigDecimal amount, String payerId) {
        return orders.values().stream().filter(o -> o.tenant().equals(tenant) && "booking".equals(o.purpose()) && "Paid".equals(o.status()) && o.consumedBy() == null
                && o.unit().equals(unit) && o.amount().compareTo(amount) == 0 && o.payerId().equals(payerId))
                .max(Comparator.comparing(o -> o.paidAt() == null ? Instant.EPOCH : o.paidAt()));
    }
    @Override public synchronized boolean recordEvent(String eventId, String orderId, String type) { return events.add(eventId); }

    private void put(String id, java.util.function.UnaryOperator<PaymentOrder> f) { orders.computeIfPresent(id, (k, o) -> f.apply(o)); }
    private PaymentOrder with(PaymentOrder o, String status, String paymentId, String method, JsonNode bank, String consumedBy, String note, int attempts, Instant paidAt) {
        return new PaymentOrder(o.orderId(), o.tenant(), o.purpose(), o.refs(), o.unit(), o.payer(), o.payerId(), o.amount(), o.currency(), status, o.idempotencyKey(), o.meta(),
                o.provider(), o.providerRef(), paymentId, method, bank, consumedBy, note, attempts, o.createdAt(), now(), paidAt);
    }

    @Override public synchronized void markPaid(String id, String paymentId, String method) {
        put(id, o -> with(o, "Paid", paymentId, method, o.bank(), o.consumedBy(), o.note(), o.attempts(), now()));
    }
    @Override public synchronized void markFailed(String id, String note) { put(id, o -> with(o, "Failed", o.paymentId(), o.method(), o.bank(), o.consumedBy(), note, o.attempts(), o.paidAt())); }
    @Override public synchronized int moveOpen(String id, String status, String method, String note) {
        PaymentOrder o = orders.get(id);
        if (o == null || !o.open()) return 0;
        put(id, x -> with(x, status, x.paymentId(), method != null ? method : x.method(), x.bank(), x.consumedBy(), note != null ? note : x.note(), x.attempts(), x.paidAt()));
        return 1;
    }
    @Override public synchronized void touch(String id) { put(id, o -> with(o, o.status(), o.paymentId(), o.method(), o.bank(), o.consumedBy(), o.note(), o.attempts(), o.paidAt())); }
    @Override public synchronized void recordBank(String id, JsonNode bank) { put(id, o -> with(o, o.status(), o.paymentId(), o.method(), bank, o.consumedBy(), o.note(), o.attempts() + 1, o.paidAt())); }
    @Override public synchronized List<PaymentOrder> openNotTouchedFor(long seconds, int limit) {
        Instant before = now().minusSeconds(seconds);
        List<PaymentOrder> out = new ArrayList<>();
        for (PaymentOrder o : orders.values()) if (o.open() && !o.updatedAt().isAfter(before) && out.size() < limit) out.add(o);
        return out;
    }
    @Override public synchronized Optional<PaymentOrder> paidBookingByPaymentId(String tenant, String paymentId) {
        return orders.values().stream().filter(o -> o.tenant().equals(tenant) && paymentId.equals(o.paymentId()) && "booking".equals(o.purpose()) && "Paid".equals(o.status())).findFirst();
    }
    @Override public synchronized boolean claim(String id, String bookingId) {
        PaymentOrder o = orders.get(id);
        if (o == null || (o.consumedBy() != null && !o.consumedBy().equals(bookingId))) return false;
        put(id, x -> with(x, x.status(), x.paymentId(), x.method(), x.bank(), bookingId, x.note(), x.attempts(), x.paidAt()));
        return true;
    }
}
