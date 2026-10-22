package com.communityos.api.billing.application;

import com.communityos.api.billing.application.port.ReconStore;
import com.communityos.api.billing.domain.Recon;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Reconciliation of the money records. Each run compares the records with each other (a receipt with what it paid, a bill with what was
 * paid on it, a paid order with what the provider captured, refunds the provider never answered, the books' balance, the units' credit
 * with the unit-credit account) and keeps each disagreement as an issue; a new one is told to the treasurer. An open issue that is no
 * longer found is cleared; one the treasurer resolved or set aside stays so. What the PROVIDER knows (money captured on an order after it
 * expired or failed) is checked by PaymentService.reconcile, which records the money and files a late-capture issue here.
 *   who   reads: the accounts (MANAGE_LEDGER), bill keepers (MANAGE_DUES), the committee; resolves: MANAGE_LEDGER
 */
public final class PaymentReconciler {
    /** A new disagreement, for the treasurer (no personal data: the issue's kind, number and amounts). */
    public record IssueFound(UUID aggregateId, CommunityId communityId, String kind, String shortId, String detail, Instant occurredAt) implements DomainEvent {
        @Override public String topic() { return "billing.recon.issue.found"; }
    }
    public record RunResult(int found, int fresh, int cleared) {}

    private final ReconStore store; private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public PaymentReconciler(ReconStore store, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) { this.store = store; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock; }

    static boolean reader(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_LEDGER) || c.has(Permission.MANAGE_DUES) || c.isCommittee() || c.category() == Caller.Category.System; }
    static boolean resolver(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_LEDGER); }

    /** One run over the caller's community (the job, or "Check now"). */
    public RunResult run(Caller c) {
        if (!reader(c)) throw new AccessDenied("Only the accounts team runs reconciliation");
        return tx.inTx(() -> {
            List<Recon.Finding> found = store.recordChecks();
            int fresh = 0;
            for (Recon.Finding f : found) if (keepAndTell(c, f)) fresh++;
            int cleared = store.clearAllBut(found);
            io.micrometer.core.instrument.Metrics.counter("cos.recon.issues.found").increment(fresh);
            return new RunResult(found.size(), fresh, cleared);
        });
    }
    /** A finding from outside the record checks (the provider's late capture): kept and told, inside the caller's transaction. */
    public void file(Caller c, Recon.Finding f) { if (keepAndTell(c, f)) io.micrometer.core.instrument.Metrics.counter("cos.recon.issues.found").increment(); }

    public List<Recon.Issue> issues(Caller c, String status) {
        if (!reader(c)) throw new AccessDenied("Only the accounts team sees reconciliation");
        if (status != null && !Recon.STATUSES.contains(status)) throw new DomainException.RuleViolated("bad-status", "Status is Open, Resolved or Ignored");
        return store.issues(status);
    }
    /** The treasurer's answer: Resolved (put right) or Ignored (known and accepted), always with a note. */
    public Recon.Issue resolve(Caller c, UUID id, long version, String status, String note) {
        if (!resolver(c)) throw new AccessDenied("Only the accounts (MANAGE_LEDGER) resolve a reconciliation issue");
        if (!"Resolved".equals(status) && !"Ignored".equals(status)) throw new DomainException.RuleViolated("bad-status", "Mark it Resolved or Ignored");
        if (note == null || note.isBlank()) throw new DomainException.RuleViolated("note-required", "Say what was done, or why it is set aside");
        return tx.inTx(() -> {
            Recon.Issue i = store.issue(id).orElseThrow(() -> new DomainException.NotFound("Reconciliation issue"));
            if (!store.resolve(id, version, status, note.strip(), c.membership() == null ? null : c.membership().value(), clock.instant())) throw new DomainException.Conflict("Issue " + i.shortId());
            audit.write(c, AuditWriter.Action.Update, "billing.recon_issue", i.id(), i.shortId(), null, status + ": " + i.detail() + " - " + note.strip(),
                List.of(new AuditWriter.Change("status", i.status(), status)));
            return store.issue(id).orElseThrow();
        });
    }

    private boolean keepAndTell(Caller c, Recon.Finding f) {
        if (!store.keep(f)) return false;
        events.publish(List.of(new IssueFound(f.refId(), c.community(), f.kind(), f.refShortId(), f.detail(), clock.instant())));
        return true;
    }
}
