package com.communityos.api.billing.application;

import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.application.port.PaymentRepository.NewPayment;
import com.communityos.api.billing.application.port.PaymentRepository.Receipt;
import com.communityos.api.billing.domain.BillingEvents.Allocation;
import com.communityos.api.billing.domain.BillingEvents.PaymentRecorded;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.domain.Ids.PaymentId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Template Method: recording money that arrived, the same way whatever the channel. The fixed skeleton (settle) is:
 *   1. verify()          - the subclass proves the money is real (provider's own record + signature, or a cashier's permission)
 *   2. idempotency       - a provider payment already recorded returns the existing receipt (webhook and app confirm both arrive)
 *   3. lock the bills    - FOR UPDATE, so two payments for one bill cannot both settle it
 *   4. record + allocate - oldest bill first; anything left over becomes the unit's credit (never lost, never refused)
 *   5. afterRecorded()   - the subclass's hook (mark the order Paid)
 *   6. events + audit    - ledger posting and the outbox, in the same transaction
 * Subclasses: GatewaySettlement (online), CounterSettlement (cash / cheque / bank transfer at the office).
 */
public abstract class Settlement<R> {
    /**
     * What verify() established. purpose "due": `dues` empty = pay the unit's oldest open bills. Another purpose with a `target`: the money is
     * applied to that booking / donation (up to what it owes). Another purpose without a target: a prepayment - it all becomes the unit's credit
     * until a record claims it.
     */
    protected record Verified(UnitId unit, OrderId order, Money amount, String method, String provider, String providerRef, Instant receivedAt, List<DueId> dues, String note,
                              String purpose, Allocation target) {
        protected Verified(UnitId unit, OrderId order, Money amount, String method, String provider, String providerRef, Instant receivedAt, List<DueId> dues, String note) {
            this(unit, order, amount, method, provider, providerRef, receivedAt, dues, note, "due", null);
        }
    }

    protected final DueRepository dues; protected final PaymentRepository payments; protected final DomainEvents events; protected final AuditWriter audit; protected final Tx tx;

    protected Settlement(DueRepository dues, PaymentRepository payments, DomainEvents events, AuditWriter audit, Tx tx) {
        this.dues = dues; this.payments = payments; this.events = events; this.audit = audit; this.tx = tx;
    }

    protected abstract Verified verify(Caller caller, R request);
    protected void afterRecorded(Caller caller, R request, Verified v, Receipt receipt, List<DomainEvent> out) {}

    public final Receipt settle(Caller caller, R request) {
        Verified v = verify(caller, request);
        if (!v.amount().isPositive()) throw new DomainException.RuleViolated("bad-amount", "The amount must be more than zero");
        try {
            Receipt r = record(caller, request, v);
            io.micrometer.core.instrument.Metrics.counter("cos.payments.recorded", "via", v.provider() == null ? "office" : v.provider()).increment();
            return r;
        }
        catch (PaymentRepository.AlreadyRecorded e) {
            // the webhook and the app's confirm raced and the other one committed first: answer with its receipt (fresh transaction)
            return tx.inTx(() -> payments.findByProviderRef(v.provider(), v.providerRef())).orElseThrow(() -> e);
        }
    }

    private Receipt record(Caller caller, R request, Verified v) {
        return tx.inTx(() -> {
            if (v.providerRef() != null) {
                var existing = payments.findByProviderRef(v.provider(), v.providerRef());
                if (existing.isPresent()) return existing.get();
            }
            boolean forBills = "due".equals(v.purpose());
            List<Due> bills = !forBills ? List.of() : v.dues().isEmpty() ? dues.lockOpenOfUnit(v.unit()) : dues.lockForSettlement(v.dues());
            for (Due d : bills) if (!v.unit().equals(d.unit())) throw new DomainException.RuleViolated("mixed-units", "A payment settles the bills of one unit");
            PaymentId id = PaymentId.random();
            String receiptNo = payments.insert(new NewPayment(id, v.order(), v.unit(), v.amount(), v.method(), v.provider(), v.providerRef(), v.receivedAt(), v.note()));
            Money left = v.amount();
            List<Allocation> allocations = new ArrayList<>();
            List<DomainEvent> out = new ArrayList<>();
            for (Due d : bills) {
                if (!left.isPositive()) break;
                Money applied = d.settle(left, v.receivedAt());
                if (!applied.isPositive()) continue;
                left = left.minus(applied);
                allocations.add(Allocation.due(d.id(), applied));
                if (!dues.save(d)) throw new DomainException.Conflict("Bill " + d.shortId());
                out.addAll(d.pullEvents());
            }
            if (!forBills && v.target() != null) {
                Money applied = left.min(v.target().amount());
                if (applied.isPositive()) { allocations.add(new Allocation(v.target().targetType(), v.target().targetId(), applied)); left = left.minus(applied); }
            }
            payments.allocate(id, allocations);
            if (left.isPositive()) payments.creditUnit(v.unit(), left, id, forBills || v.target() != null ? "overpayment" : "prepayment");
            Receipt receipt = new Receipt(id, receiptNo, v.unit(), v.order(), v.amount(), v.method(), v.provider(), v.receivedAt(), allocations, left);
            out.add(new PaymentRecorded(id, receiptNo, caller.community(), v.unit(), v.order(), v.amount(), allocations, left, v.method(), v.provider(), v.receivedAt()));
            afterRecorded(caller, request, v, receipt, out);
            events.publish(out);
            audit.write(caller, AuditWriter.Action.Create, "billing.payment", id.value(), receiptNo, v.unit().value(),
                "Recorded " + v.method() + " payment " + v.amount() + (left.isPositive() ? " (" + left + " kept as credit)" : ""),
                List.of(new AuditWriter.Change("amount", null, v.amount().toString())));
            return receipt;
        });
    }
}
