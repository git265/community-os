package com.communityos.api.billing.application.port;

import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.OrderId;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** Platform view across communities: which community a provider's order belongs to (webhooks carry no community), and orders to reconcile. */
public interface OrderLocator {
    record Located(CommunityId community, OrderId order) {}
    Optional<Located> byProviderRef(String provider, String providerOrderRef);
    List<Located> openOlderThan(Instant before, int limit);
}
