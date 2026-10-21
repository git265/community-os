package com.communityos.api.billing.application.port;

import com.communityos.api.billing.domain.PaymentOrder;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.OrderId;
import java.util.Optional;

public interface PaymentOrderRepository {
    Optional<PaymentOrder> findById(OrderId id);
    Optional<PaymentOrder> findForUpdate(OrderId id);
    Optional<PaymentOrder> findByIdempotencyKey(MembershipId payer, String key);
    Optional<PaymentOrder> findByProviderRefForUpdate(String provider, String providerOrderRef);
    void insert(PaymentOrder order);
    boolean save(PaymentOrder order);
}
