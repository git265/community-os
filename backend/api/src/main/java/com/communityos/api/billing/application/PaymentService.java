package com.communityos.api.billing.application;

import com.communityos.api.billing.application.gateway.GatewayRegistry;
import com.communityos.api.billing.application.gateway.PaymentGateway;
import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.application.port.InboundEvents;
import com.communityos.api.billing.application.port.OrderLocator;
import com.communityos.api.billing.application.port.PaymentOrderRepository;
import com.communityos.api.billing.application.port.PaymentRepository.Receipt;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.billing.domain.OrderStatus;
import com.communityos.api.billing.domain.PaymentOrder;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.security.SystemCaller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Online payments:
 *   createOrder(dues)          the server prices the bills (what is owed now) - the app sends bill ids only, never an amount;
 *                              the same Idempotency-Key returns the same order instead of charging twice
 *   confirm(order, payment)    the app's checkout callback: signature checked, then the provider's own record fetched and settled
 *   webhook(provider, body)    the provider's server call: signature on the raw body, de-duplicated, settled (whichever of the two comes first wins;
 *                              the other finds the receipt already there)
 *   reconcile()                a job for orders whose webhook never came: asks the provider, settles or expires them
 */
public final class PaymentService {
    private static final Logger log = LoggerFactory.getLogger(PaymentService.class);
    /** Bills: dueIds. A prepayment for a booking / donation: purpose, the unit and the amount (checked again when it is claimed). */
    public record CreateOrder(List<DueId> dueIds, String purpose, com.communityos.api.shared.domain.Ids.UnitId unitId, com.communityos.api.shared.domain.Money amount) {
        public CreateOrder(List<DueId> dueIds) { this(dueIds, "due", null, null); }
        boolean forBills() { return purpose == null || "due".equals(purpose); }
    }
    public record OrderView(PaymentOrder order, Map<String, Object> checkout, java.util.UUID paymentId) {
        public OrderView(PaymentOrder order, Map<String, Object> checkout) { this(order, checkout, null); }
    }

    private final DueRepository dues; private final com.communityos.api.billing.application.port.PaymentRepository payments; private final PaymentOrderRepository orders; private final GatewayRegistry gateways; private final GatewaySettlement settlement;
    private final InboundEvents inbound; private final OrderLocator locator; private final DomainEvents events; private final Tx tx;
    private final Clock clock; private final Duration orderTtl; private final String currency;
    private final DuePolicy policy = new DuePolicy();

    public PaymentService(DueRepository dues, com.communityos.api.billing.application.port.PaymentRepository payments, PaymentOrderRepository orders, GatewayRegistry gateways,
                          GatewaySettlement settlement, InboundEvents inbound, OrderLocator locator, DomainEvents events, Tx tx, Clock clock, Duration orderTtl, String currency) {
        this.dues = dues; this.payments = payments; this.orders = orders; this.gateways = gateways; this.settlement = settlement; this.inbound = inbound; this.locator = locator;
        this.events = events; this.tx = tx; this.clock = clock; this.orderTtl = orderTtl; this.currency = currency;
    }

    private RefundService refunds;
    /** Refund webhooks go to the refund service (wired after both exist). */
    public PaymentService refunds(RefundService r) { this.refunds = r; return this; }
    private PaymentReconciler reconciler;
    /** Where money captured on a closed order is reported (wired after both exist). */
    public PaymentService reconciler(PaymentReconciler r) { this.reconciler = r; return this; }

    public OrderView createOrder(Caller c, CreateOrder cmd, String idempotencyKey) {
        if (c.membership() == null) throw new AccessDenied("Sign in to pay");
        if (idempotencyKey == null || idempotencyKey.length() < 8 || idempotencyKey.length() > 128)
            throw new DomainException.RuleViolated("idempotency-key-required", "Send an Idempotency-Key header (8-128 characters) with a payment");
        if (cmd.forBills() && (cmd.dueIds() == null || cmd.dueIds().isEmpty() || cmd.dueIds().size() > 24)) throw new DomainException.RuleViolated("bad-dues", "Choose 1 to 24 bills");
        if (!cmd.forBills()) {
            if (cmd.unitId() == null) throw new DomainException.RuleViolated("unit-required", "Say which unit pays");
            boolean staff = c.isSuperAdmin() || c.hasAny(Permission.MANAGE_AMENITIES, Permission.MANAGE_CULTURAL, Permission.MANAGE_DUES);
            if (!staff && !c.units().contains(cmd.unitId())) throw new AccessDenied("You can only pay for your own unit");
        }
        Optional<PaymentOrder> again = orders.findByIdempotencyKey(c.membership(), idempotencyKey);
        if (again.isPresent()) {
            PaymentOrder o = again.get();
            boolean same = cmd.forBills()
                ? new LinkedHashSet<>(o.items().stream().map(PaymentOrder.Item::due).toList()).equals(new LinkedHashSet<>(cmd.dueIds()))
                : o.purpose().equals(cmd.purpose()) && o.unit().equals(cmd.unitId()) && o.amount().compareTo(cmd.amount()) == 0;
            if (!same) throw new DomainException.RuleViolated("idempotency-key-reused", "This Idempotency-Key was already used for another payment");
            return view(o);
        }
        PaymentGateway gateway = gateways.defaultGateway();
        PaymentOrder order = !cmd.forBills()
            ? tx.inTx(() -> { PaymentOrder o = PaymentOrder.prepay(cmd.purpose(), c.community(), cmd.unitId(), c.membership(), cmd.amount(), currency, gateway.name(), idempotencyKey, clock.instant().plus(orderTtl)); orders.insert(o); return o; })
            : tx.inTx(() -> {
            List<Due> bills = new java.util.ArrayList<>();
            for (DueId id : new LinkedHashSet<>(cmd.dueIds())) {
                Due d = dues.findById(id, policy.readScope(c)).orElseThrow(AccessDenied.NotVisible::new);
                if (!policy.mayPay(c, d)) throw new AccessDenied("You cannot pay this bill");
                bills.add(d);
            }
            PaymentOrder o = PaymentOrder.price(c.community(), bills.get(0).unit(), c.membership(), bills, currency, gateway.name(), idempotencyKey, clock.instant().plus(orderTtl));
            orders.insert(o);
            return o;
        });
        // the provider call happens OUTSIDE the transaction: no database connection is held while waiting on the network
        PaymentGateway.ProviderOrder po;
        try {
            po = gateway.createOrder(new PaymentGateway.OrderRequest(order.id().toString(), order.shortId(), order.amount(), order.currency(),
                Map.of("community", c.community().toString(), "order", order.id().toString())));
        } catch (com.communityos.api.shared.resilience.TransientFailure | com.communityos.api.shared.resilience.CircuitBreaker.OpenException e) {
            // the order stays Created with no provider order and expires: nothing could have been charged
            throw new com.communityos.api.shared.resilience.TransientFailure("The payment service is not answering right now - nothing was charged. Please try again in a minute.", e);
        }
        PaymentOrder saved = tx.inTx(() -> {
            PaymentOrder o = orders.findForUpdate(order.id()).orElseThrow();
            if (o.status() == OrderStatus.CREATED) { o.handedToProvider(po.providerOrderRef()); if (!orders.save(o)) throw new DomainException.Conflict("Payment order"); }
            return o;
        });
        return new OrderView(saved, po.checkout());
    }

    public OrderView getOrder(Caller c, OrderId id) {
        PaymentOrder o = orders.findById(id).orElseThrow(AccessDenied.NotVisible::new);
        if (!o.payer().equals(c.membership()) && !c.isSuperAdmin() && !c.hasAny(Permission.MANAGE_DUES, Permission.MANAGE_LEDGER)) throw new AccessDenied.NotVisible();
        return view(o);
    }

    public Receipt confirm(Caller c, OrderId id, String providerPaymentRef, String signature) {
        PaymentOrder o = orders.findById(id).orElseThrow(AccessDenied.NotVisible::new);
        if (!o.payer().equals(c.membership())) throw new AccessDenied.NotVisible();
        PaymentGateway g = gateways.get(o.provider());
        if (o.providerOrderRef() == null || providerPaymentRef == null || !g.verifyCheckout(o.providerOrderRef(), providerPaymentRef, signature))
            throw new DomainException.RuleViolated("bad-signature", "The payment confirmation could not be verified");
        PaymentGateway.ProviderPayment p = g.fetchPayment(providerPaymentRef);
        return settlement.settle(c, new GatewaySettlement.Request(id, g, p));
    }

    /** A provider webhook. Returns normally for anything we do not act on (so the provider stops retrying); throws BadSignature for a forgery. */
    public void webhook(String provider, Map<String, String> headers, byte[] rawBody) {
        PaymentGateway g = gateways.get(provider);
        Optional<PaymentGateway.WebhookEvent> read = g.readWebhook(headers, rawBody);
        if (read.isEmpty()) return;
        PaymentGateway.WebhookEvent e = read.get();
        if (inbound.alreadyProcessed(provider, e.eventId())) { io.micrometer.core.instrument.Metrics.counter("cos.webhooks", "provider", provider, "result", "duplicate").increment(); return; }
        io.micrometer.core.instrument.Metrics.counter("cos.webhooks", "provider", provider, "result", e.refund() ? "refund" : "payment").increment();
        if (e.refund()) {                                                    // a refund's news: the refund service fetches the provider's record and tells the owner
            inbound.received(provider, e.eventId(), null, e.type());
            if (refunds != null) refunds.webhook(provider, e.providerRefundRef());
            inbound.markProcessed(provider, e.eventId());
            return;
        }
        Optional<OrderLocator.Located> where = e.providerOrderRef() == null ? Optional.empty() : locator.byProviderRef(provider, e.providerOrderRef());
        inbound.received(provider, e.eventId(), where.map((w) -> w.community().value()).orElse(null), e.type());
        if (where.isEmpty()) { log.warn("{} webhook {} for unknown order {}", provider, e.eventId(), e.providerOrderRef()); inbound.markProcessed(provider, e.eventId()); return; }
        Caller system = SystemCaller.of(where.get().community(), "payments " + provider);
        CallerHolder.runAs(system, () -> { applyProviderState(system, g, where.get().order(), e.providerPaymentRef()); return null; });
        inbound.markProcessed(provider, e.eventId());
    }

    /** Orders that stayed open: ask the provider. Run by a scheduler every few minutes. */
    public int reconcile(int batch) {
        int n = 0;
        for (OrderLocator.Located l : locator.openOlderThan(clock.instant().minus(Duration.ofMinutes(5)), batch)) {
            Caller system = SystemCaller.of(l.community(), "payments reconcile");
            try { CallerHolder.runAs(system, () -> { reconcileOne(system, l.order()); return null; }); n++; }
            catch (RuntimeException ex) { log.warn("reconcile of order {} failed: {}", l.order(), ex.toString()); }
        }
        // orders that expired or failed: the bank may still have taken the money (a UPI approval after the checkout closed). It is recorded
        // (on the order's bills, the rest as credit) and the treasurer is told; never left captured with no receipt.
        for (OrderLocator.Located l : locator.closedToCheck(batch)) {
            Caller system = SystemCaller.of(l.community(), "payments reconcile");
            try { CallerHolder.runAs(system, () -> { reconcileClosed(system, l.order()); return null; }); n++; }
            catch (RuntimeException ex) { log.warn("reconcile of closed order {} failed: {}", l.order(), ex.toString()); }
        }
        return n;
    }
    private void reconcileClosed(Caller system, OrderId id) {
        PaymentOrder o = orders.findById(id).orElse(null);
        if (o == null || o.providerOrderRef() == null) return;
        PaymentGateway g = gateways.get(o.provider());
        String was = o.status().label();
        for (PaymentGateway.ProviderPayment p : g.paymentsOf(o.providerOrderRef())) {
            if (!p.captured()) continue;
            settlement.settle(system, new GatewaySettlement.Request(id, g, p));
            if (reconciler != null) tx.run(() -> reconciler.file(system, new com.communityos.api.billing.domain.Recon.Finding(com.communityos.api.billing.domain.Recon.LATE_CAPTURE, "payment_order", id.value(),
                o.shortId(), p.providerPaymentRef(), o.amount().amount(), p.amount().amount(), "Order " + o.shortId() + " was " + was.toLowerCase(java.util.Locale.ROOT)
                    + " but the provider captured " + p.amount().amount().toPlainString() + " on it - recorded now; check the receipt")));
        }
        tx.run(() -> orders.checked(id));
    }
    /** Captured payments on an open order: every one is recorded (a second capture becomes credit, and reconciliation flags it). */

    private void reconcileOne(Caller system, OrderId id) {
        PaymentOrder o = orders.findById(id).orElse(null);
        if (o == null || o.status().isFinal()) return;
        PaymentGateway g = gateways.get(o.provider());
        if (o.providerOrderRef() != null) {
            boolean any = false;
            for (PaymentGateway.ProviderPayment p : g.paymentsOf(o.providerOrderRef())) if (p.captured()) { settlement.settle(system, new GatewaySettlement.Request(id, g, p)); any = true; }
            if (any) return;
        }
        tx.run(() -> {
            PaymentOrder locked = orders.findForUpdate(id).orElseThrow();
            if (locked.expireIfDue(clock.instant())) { orders.save(locked); events.publish(locked.pullEvents()); }
        });
    }

    private void applyProviderState(Caller system, PaymentGateway g, OrderId order, String providerPaymentRef) {
        if (providerPaymentRef == null) return;
        PaymentGateway.ProviderPayment p = g.fetchPayment(providerPaymentRef);        // trust the provider's record, not the webhook body
        if (p.captured()) { settlement.settle(system, new GatewaySettlement.Request(order, g, p)); return; }
        if (p.failed()) tx.run(() -> {
            PaymentOrder o = orders.findForUpdate(order).orElseThrow();
            o.failed(p.failureReason(), clock.instant());
            orders.save(o);
            events.publish(o.pullEvents());
        });
    }

    private OrderView view(PaymentOrder o) {
        return new OrderView(o, checkoutOf(o), o.status() == OrderStatus.PAID ? payments.ofOrder(o.id()).map((p) -> p.value()).orElse(null) : null);
    }
    private Map<String, Object> checkoutOf(PaymentOrder o) {
        return o.providerOrderRef() == null ? Map.of() : Map.of("provider", o.provider(), "providerOrderRef", o.providerOrderRef(), "amount", o.amount().toString(), "currency", o.currency());
    }
}
