package com.communityos.api.identity.domain;

import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import java.time.Instant;
import java.util.UUID;

/**
 * A stored refresh token (only its SHA-256). Rotating: each use gives a new token in the same family and marks this one used. A used token
 * presented again means it was copied - the whole family is revoked and that device and the thief are both signed out.
 */
public record RefreshToken(UUID id, UUID familyId, PersonId person, CommunityId community, MembershipId membership, byte[] tokenHash,
                           Instant expiresAt, Instant usedAt, Instant revokedAt) {
    public enum Verdict { OK, EXPIRED, REVOKED, REUSED }
    public Verdict check(Instant now) {
        if (revokedAt != null) return Verdict.REVOKED;
        if (usedAt != null) return Verdict.REUSED;
        if (!now.isBefore(expiresAt)) return Verdict.EXPIRED;
        return Verdict.OK;
    }
}
