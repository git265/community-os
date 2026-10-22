package com.communityos.api.billing.application.port;

import com.communityos.api.billing.domain.Recon;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Reconciliation issues and the record checks behind them, in the caller's community (explicit SQL: JdbcReconStore). */
public interface ReconStore {
    /** Every record check (see Recon.RECORD_CHECKS) run now. */
    List<Recon.Finding> recordChecks();
    /** Keep a finding: a new issue (true), or the known one seen again (false; a resolved or ignored one stays so). */
    boolean keep(Recon.Finding f);
    /** Open issues of the record checks that this run did not find again: cleared. */
    int clearAllBut(List<Recon.Finding> found);
    List<Recon.Issue> issues(String status);
    Optional<Recon.Issue> issue(UUID id);
    boolean resolve(UUID id, long version, String status, String note, UUID by, Instant at);
}
