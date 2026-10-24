package com.communityos.api.site.application.port;

import com.communityos.api.shared.domain.Ids.CommunityId;
import java.util.Optional;
import java.util.UUID;

/** Port: which community and bridge a bridge token (its SHA-256, hex) belongs to. Read before anyone knows the community. */
public interface BridgeLocator {
    record Located(CommunityId community, UUID bridge, String name, String status) {}
    Optional<Located> byTokenHash(String hash);
}
