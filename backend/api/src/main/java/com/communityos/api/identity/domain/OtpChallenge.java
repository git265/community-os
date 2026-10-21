package com.communityos.api.identity.domain;

import java.time.Instant;
import java.util.UUID;

/** One sign-in code sent to a phone. Only an HMAC of the code is kept; it can be tried a few times, once, until it expires. */
public record OtpChallenge(UUID id, Phone phone, byte[] codeHash, int attempts, int maxAttempts, Instant expiresAt, Instant consumedAt) {
    public boolean usable(Instant now) { return consumedAt == null && now.isBefore(expiresAt) && attempts < maxAttempts; }
}
