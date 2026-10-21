package com.communityos.api.billing.application;

import com.communityos.api.billing.application.gateway.PaymentGateway;
import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.application.port.PaymentOrderRepository;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.domain.PaymentOrder;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Online money. The amount, status and order come from the PROVIDER's record of the payment (fetched server to server), never from the app;
 * the payment must belong to the order it claims. The order is then marked Paid in the same transaction.
 */
public final class GatewaySettlement extends Settlement<GatewaySettlement.Request> {
    public record Request(OrderId orderId, PaymentGateway gateway, PaymentGateway.ProviderPayment payment) {}
    private static final Logger log = LoggerFactory.getLogger(GatewaySettlement.class);

    private final PaymentOrderRepository orders; private final Clock clock;
    public GatewaySettlement(DueRepository dues, PaymentRepository payments, DomainEvents events, AuditWriter audit, Tx tx, PaymentOrderRepository orders, Clock clock) {
        super(dues, payments, events, audit, tx); this.orders = orders; this.clock = clock;
    }

    @Override protected Verified verify(Caller c, Request r) {
        PaymentGateway.ProviderPayment p = r.payment();
        PaymentOrder o = orders.findById(r.orderId()).orElseThrow(() -> new DomainException.NotFound("Payment order"));
        if (!o.provider().equals(r.gateway().name()) || o.providerOrderRef() == null || !o.providerOrderRef().equals(p.providerOrderRef()))
            throw new DomainException.RuleViolated("payment-mismatch", "This payment does not belong to this order");
        if (!p.captured()) throw new DomainException.RuleViolated("not-captured", "The payment has not been completed");
        if (!o.currency().equals(p.currency())) throw new DomainException.RuleViolated("payment-mismatch", "Currency does not match the order");
        if (p.amount().compareTo(o.amount()) != 0)                                         // still recorded: the money is real; the difference becomes credit or stays owed
            log.warn("order {} priced {} but provider captured {}", o.id(), o.amount(), p.amount());
        return new Verified(o.unit(), o.id(), p.amount(), methodLabel(p.method()), r.gateway().name(), p.providerPaymentRef(), clock.instant(),
            o.items().stream().map(PaymentOrder.Item::due).filter(java.util.Objects::nonNull).toList(), null, o.purpose(), null);
    }

    @Override protected void afterRecorded(Caller c, Request r, Verified v, PaymentRepository.Receipt receipt, List<DomainEvent> out) {
        PaymentOrder o = orders.findForUpdate(r.orderId()).orElseThrow();
        o.paid(v.receivedAt());
        if (!orders.save(o)) throw new DomainException.Conflict("Payment order");
        out.addAll(o.pullEvents());
    }

    static String methodLabel(String providerMethod) {
        if (providerMethod == null) return "UPI";
        return switch (providerMethod.toLowerCase()) {
            case "card" -> "Card"; case "netbanking" -> "Net banking"; case "wallet" -> "Wallet"; default -> "UPI";
        };
    }
}
