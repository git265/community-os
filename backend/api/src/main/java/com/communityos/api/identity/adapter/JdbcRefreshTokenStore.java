package com.communityos.api.identity.adapter;

import com.communityos.api.identity.application.port.RefreshTokenStore;
import com.communityos.api.identity.domain.RefreshToken;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.jdbc.Rows;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** identity.refresh_token on the platform connection. Only SHA-256 hashes are stored. */
public final class JdbcRefreshTokenStore implements RefreshTokenStore {
    static final String INSERT = """
        INSERT INTO identity.refresh_token (id, family_id, person_id, community_id, membership_id, token_hash, expires_at, user_agent, ip)
        VALUES (CAST(:id AS uuid), CAST(:family AS uuid), CAST(:person AS uuid), CAST(:community AS uuid), CAST(:membership AS uuid), :hash,
                CAST(:expires AS timestamptz), left(:ua, 300), CAST(:ip AS inet))""";
    static final String FIND = """
        SELECT id, family_id, person_id, community_id, membership_id, token_hash, expires_at, used_at, revoked_at
        FROM identity.refresh_token WHERE token_hash = :hash FOR UPDATE""";
    static final String USED = "UPDATE identity.refresh_token SET used_at = CAST(:at AS timestamptz) WHERE id = CAST(:id AS uuid) AND used_at IS NULL";
    static final String REVOKE_FAMILY = """
        UPDATE identity.refresh_token SET revoked_at = CAST(:at AS timestamptz), revoke_reason = :reason WHERE family_id = CAST(:family AS uuid) AND revoked_at IS NULL""";
    static final String REVOKE_MEMBERSHIP = """
        UPDATE identity.refresh_token SET revoked_at = CAST(:at AS timestamptz), revoke_reason = :reason WHERE membership_id = CAST(:membership AS uuid) AND revoked_at IS NULL""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcRefreshTokenStore(NamedParameterJdbcTemplate platformJdbc) { this.jdbc = platformJdbc; }

    @Override public void save(RefreshToken t, String userAgent, String ip) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", t.id().toString()); p.put("family", t.familyId().toString()); p.put("person", t.person().toString());
        p.put("community", t.community().toString()); p.put("membership", t.membership().toString()); p.put("hash", t.tokenHash());
        p.put("expires", Rows.ts(t.expiresAt())); p.put("ua", userAgent == null ? "" : userAgent); p.put("ip", ip);
        jdbc.update(INSERT, p);
    }
    @Override public Optional<RefreshToken> findByHashForUpdate(byte[] hash) {
        return jdbc.query(FIND, Map.of("hash", hash), (rs, i) -> new RefreshToken(Rows.uuid(rs, "id"), Rows.uuid(rs, "family_id"),
            new PersonId(Rows.uuid(rs, "person_id")), new CommunityId(Rows.uuid(rs, "community_id")), new MembershipId(Rows.uuid(rs, "membership_id")),
            rs.getBytes("token_hash"), Rows.instant(rs, "expires_at"), Rows.instant(rs, "used_at"), Rows.instant(rs, "revoked_at"))).stream().findFirst();
    }
    @Override public void markUsed(UUID id, Instant at) { jdbc.update(USED, Map.of("id", id.toString(), "at", Rows.ts(at))); }
    @Override public int revokeFamily(UUID family, String reason, Instant at) { return jdbc.update(REVOKE_FAMILY, Map.of("family", family.toString(), "reason", reason, "at", Rows.ts(at))); }
    @Override public int revokeAllOfMembership(UUID membership, String reason, Instant at) {
        return jdbc.update(REVOKE_MEMBERSHIP, Map.of("membership", membership.toString(), "reason", reason, "at", Rows.ts(at)));
    }
}
