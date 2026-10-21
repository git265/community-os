package com.communityos.api.billing.application;

import com.communityos.api.billing.application.gateway.GatewayRegistry;
import com.communityos.api.billing.application.gateway.PaymentGateway;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.resilience.CircuitBreaker;
import com.communityos.api.shared.resilience.TransientFailure;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.SystemCaller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Money sent back through the payment provider, to the card / UPI / bank account it came from (a booking's fee or deposit paid online).
 *
 *   initiate   our refund row first (Pending; the database refuses more than the payment brought in), then the provider is asked - outside the
 *              transaction; a provider that does not answer leaves the row Failed and the caller is told to try again (nothing went back)
 *   webhook    the provider's refund.processed / refund.failed: its own record is fetched (never the webhook body) and the owner is told
 *   reconcile  refunds still pending after a few minutes: the provider is asked again (a lost webhook)
 * The owner (the booking) moves its money and its ledger only when the provider says the refund is processed.
 */
public final class RefundService {
    private static final Logger log = LoggerFactory.getLogger(RefundService.class);
    public record Refund(UUID id, String shortId, CommunityId community, String ownerType, UUID ownerId, String part, UUID paymentId, String provider, String providerPaymentRef,
                         String providerRefundRef, Money amount, String status, String failureReason, Instant processedAt) {
        public boolean pending() { return "Pending".equals(status); }
    }
    /** A module whose money a refund returns. Told once, when the provider says processed or failed. */
    public interface Owner { void settled(Caller system, Refund r); }
    public interface Store {
        record OnlinePayment(UUID id, String provider, String providerPaymentRef, Money amount) {}
        Optional<OnlinePayment> onlinePayment(UUID paymentId);
        Refund insert(String ownerType, UUID ownerId, String part, OnlinePayment p, Money amount);
        Optional<Refund> get(UUID id);
        void asked(UUID id, String providerRefundRef);
        /** Pending -> Processed / Failed, once; false when it was no longer pending. */
        boolean finish(UUID id, String status, String reason, Instant at);
        List<Refund> ofOwner(String ownerType, UUID ownerId);
    }
    public interface Locator {
        record Located(CommunityId community, UUID id) {}
        Optional<Located> byProviderRef(String provider, String providerRefundRef);
        List<Located> pendingOlderThan(Instant before, int limit);
    }

    private final Store store; private final Locator locator; private final GatewayRegistry gateways; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    private final Map<String, Owner> owners = new ConcurrentHashMap<>();
    public RefundService(Store store, Locator locator, GatewayRegistry gateways, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.locator = locator; this.gateways = gateways; this.audit = audit; this.tx = tx; this.clock = clock;
    }
    public RefundService register(String ownerType, Owner owner) { owners.put(ownerType, owner); return this; }

    public List<Refund> ofOwner(String ownerType, UUID ownerId) { return store.ofOwner(ownerType, ownerId); }

    /** Ask the provider to send `amount` of an online payment back. Called by the owner's service, which checked who may and that it is due. */
    public Refund initiate(Caller c, String ownerType, UUID ownerId, String part, UUID paymentId, Money amount) {
        if (!owners.containsKey(ownerType)) throw new IllegalStateException("no refund owner " + ownerType);
        Store.OnlinePayment p = paymentId == null ? null : store.onlinePayment(paymentId).orElse(null);
        if (p == null) throw new DomainException.RuleViolated("not-online", "This was not paid online, so it cannot be sent back automatically - pay it out and record it instead");
        Refund r = tx.inTx(() -> {
            Refund x = store.insert(ownerType, ownerId, part, p, amount);
            audit.write(c, AuditWriter.Action.Create, "billing.gateway_refund", x.id(), x.shortId(), null, "Refund of " + amount.amount().toPlainString() + " asked from " + p.provider(), List.of());
            return x;
        });
        PaymentGateway g = gateways.get(p.provider());
        PaymentGateway.ProviderRefund pr;
        try { pr = g.refund(new PaymentGateway.RefundRequest(p.providerPaymentRef(), amount, r.id().toString(), Map.of("community", c.community().toString(), "refund", r.shortId()))); }
        catch (TransientFailure | CircuitBreaker.OpenException e) {
            store.finish(r.id(), "Failed", "the payment service did not answer", clock.instant());
            throw new TransientFailure("The payment service is not answering, so nothing was sent back. Try again in a few minutes.", e);
        } catch (RuntimeException e) {
            store.finish(r.id(), "Failed", e.getMessage() == null ? "refused by the provider" : e.getMessage(), clock.instant());
            throw new DomainException.RuleViolated("refund-refused", "The payment service refused the refund: " + (e.getMessage() == null ? "no reason given" : e.getMessage()));
        }
        store.asked(r.id(), pr.providerRefundRef());
        if (pr.processed() || pr.failed()) return conclude(c, r.id(), pr);
        return store.get(r.id()).orElseThrow();
    }

    /** The provider's webhook about a refund (the payment webhook passes these on). */
    public void webhook(String provider, String providerRefundRef) {
        if (providerRefundRef == null) return;
        Optional<Locator.Located> where = locator.byProviderRef(provider, providerRefundRef);
        if (where.isEmpty()) { log.warn("{} refund webhook for unknown refund {}", provider, providerRefundRef); return; }
        Caller system = SystemCaller.of(where.get().community(), "refunds " + provider);
        CallerHolder.runAs(system, () -> { refresh(system, where.get().id()); return null; });
    }

    /** Refunds still pending: ask the provider (a webhook that never came). */
    public int reconcile(int batch) {
        int n = 0;
        for (Locator.Located l : locator.pendingOlderThan(clock.instant().minus(Duration.ofMinutes(2)), batch)) {
            Caller system = SystemCaller.of(l.community(), "refunds reconcile");
            try { CallerHolder.runAs(system, () -> { refresh(system, l.id()); return null; }); n++; }
            catch (RuntimeException e) { log.warn("refund {} reconcile failed: {}", l.id(), e.toString()); }
        }
        return n;
    }

    private void refresh(Caller system, UUID id) {
        Refund r = store.get(id).orElse(null);
        if (r == null || !r.pending() || r.providerRefundRef() == null) return;
        PaymentGateway.ProviderRefund pr = gateways.get(r.provider()).fetchRefund(r.providerRefundRef());   // the provider's record, not the webhook body
        if (pr.processed() || pr.failed()) conclude(system, id, pr);
    }
    private Refund conclude(Caller c, UUID id, PaymentGateway.ProviderRefund pr) {
        return tx.inTx(() -> {
            String status = pr.processed() ? "Processed" : "Failed";
            if (!store.finish(id, status, pr.processed() ? null : (pr.failureReason() == null ? "refused by the bank" : pr.failureReason()), clock.instant())) return store.get(id).orElseThrow();
            Refund done = store.get(id).orElseThrow();
            owners.get(done.ownerType()).settled(c, done);
            audit.write(c, AuditWriter.Action.Update, "billing.gateway_refund", done.id(), done.shortId(), null, "Refund " + status.toLowerCase()
                + (done.failureReason() == null ? "" : ": " + done.failureReason()), List.of(new AuditWriter.Change("status", "Pending", status)));
            return done;
        });
    }
}
