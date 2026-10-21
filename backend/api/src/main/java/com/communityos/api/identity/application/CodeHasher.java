package com.communityos.api.identity.application;

import com.communityos.api.shared.crypto.Crypto;
import java.util.UUID;

/**
 * HMAC-SHA256(server pepper, challenge id + code). With the pepper kept outside the database (secret manager), a stolen database does not
 * give the codes away even though a 6-digit code has only a million values.
 */
public final class CodeHasher {
    private final byte[] pepper;
    public CodeHasher(String pepper) {
        if (pepper == null || pepper.length() < 32) throw new IllegalArgumentException("auth.otp-pepper must be at least 32 characters");
        this.pepper = Crypto.utf8(pepper);
    }
    public byte[] hash(UUID challengeId, String code) { return Crypto.hmacSha256(pepper, Crypto.utf8(challengeId + ":" + code)); }
    public boolean matches(UUID challengeId, String code, byte[] stored) { return Crypto.constantTimeEquals(hash(challengeId, code), stored); }
}
