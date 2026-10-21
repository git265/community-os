package com.communityos.api.identity.application.port;

import com.communityos.api.identity.domain.RefreshToken;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public interface RefreshTokenStore {
    void save(RefreshToken t, String userAgent, String ip);
    Optional<RefreshToken> findByHashForUpdate(byte[] tokenHash);
    void markUsed(UUID id, Instant at);
    int revokeFamily(UUID familyId, String reason, Instant at);
    int revokeAllOfMembership(java.util.UUID membershipId, String reason, Instant at);
}
