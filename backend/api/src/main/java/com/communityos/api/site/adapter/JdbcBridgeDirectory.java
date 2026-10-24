package com.communityos.api.site.adapter;

import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.site.application.port.BridgeLocator;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Which community a bridge's token belongs to (the platform connection: the token arrives before anyone knows the community). */
public final class JdbcBridgeDirectory implements BridgeLocator {
    static final String BRIDGE_BY_TOKEN = "SELECT b.community_id, b.id, b.name, b.status FROM gate.bridge b WHERE b.token_hash = :hash";

    private final NamedParameterJdbcTemplate platform;
    public JdbcBridgeDirectory(NamedParameterJdbcTemplate platform) { this.platform = platform; }

    @Override public Optional<Located> byTokenHash(String hash) {
        return platform.query(BRIDGE_BY_TOKEN, Map.of("hash", hash),
            (rs, i) -> new Located(new CommunityId(Rows.uuid(rs, "community_id")), Rows.uuid(rs, "id"), rs.getString("name"), rs.getString("status"))).stream().findFirst();
    }
}
