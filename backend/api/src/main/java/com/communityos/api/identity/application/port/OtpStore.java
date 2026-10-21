package com.communityos.api.identity.application.port;

import com.communityos.api.identity.domain.OtpChallenge;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public interface OtpStore {
    void save(OtpChallenge c, String ip);
    /** Locks the row for the rest of the transaction, so two guesses at once both count. */
    Optional<OtpChallenge> findForUpdate(UUID id);
    void recordAttempt(UUID id);
    /** false if it was already spent (a simultaneous submission won). */
    boolean consume(UUID id, Instant at);
    int purgeExpired(Instant before);
}
