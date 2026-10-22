package com.communityos.api.billing.application;

import com.communityos.api.billing.application.port.LateFeeStore;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.billing.domain.LateFees;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.util.List;

/**
 * Late fees on the server: the treasurer's "Apply now" (or preview) and the daily job (when the community turned "add automatically" on).
 * Each fee is its own bill in the Late fee category, tied to the bill and month it is charged for; the database refuses a second fee for
 * the same month, and that fee's bill is then rolled back with it - so two runs at once never charge twice.
 */
public final class LateFeeService {
    public record Planned(String billShortId, int month, BigDecimal amount) {}
    public record Run(int charged, BigDecimal total, List<Planned> fees) {}

    private final LateFeeStore store; private final DueService dues; private final Tx tx; private final Clock clock;
    public LateFeeService(LateFeeStore store, DueService dues, Tx tx, Clock clock) { this.store = store; this.dues = dues; this.tx = tx; this.clock = clock; }

    static void require(Caller c) { if (!(c.isSuperAdmin() || c.has(Permission.MANAGE_DUES))) throw new AccessDenied("Only the billing team applies late fees"); }

    /** What would be charged today, without charging it. */
    public Run preview(Caller c) {
        require(c);
        List<LateFees.Fee> plan = plan();
        return new Run(0, total(plan), plan.stream().map((f) -> new Planned(f.bill().shortId(), f.no(), f.amount())).toList());
    }
    /** Charge what is due now (by hand, or `auto` from the job when the community asked for it). */
    public Run apply(Caller c, boolean auto) {
        require(c);
        LateFees.Settings s = store.settings();
        if (!s.enabled()) throw new DomainException.RuleViolated("late-fees-off", "Late fees are switched off in the finance settings");
        if (auto && !s.auto()) return new Run(0, BigDecimal.ZERO, List.of());
        LocalDate today = LocalDate.now(clock);
        int n = 0; BigDecimal total = BigDecimal.ZERO; List<Planned> done = new java.util.ArrayList<>();
        for (LateFees.Fee f : LateFees.plan(store.overdue(), store.charged(), s, today)) {
            boolean charged;
            try { charged = tx.inTx(() -> {
                Due fee = dues.raise(c, new DueService.RaiseDue(new UnitId(f.bill().unitId()), LateFees.CATEGORY, null,
                    "Late fee for bill " + f.bill().shortId() + (f.bill().billedMonth() == null ? "" : " (" + f.bill().billedMonth().getMonth() + " " + f.bill().billedMonth().getYear() + ")")
                        + " · month " + f.no() + ", unpaid after " + f.bill().dueDate(), new Money(f.amount()), today));
                if (!store.tie(fee.id().value(), f.bill().id(), f.no())) throw new AlreadyCharged();
                return true;
            }); } catch (AlreadyCharged e) { charged = false; }
            if (charged) { n++; total = total.add(f.amount()); done.add(new Planned(f.bill().shortId(), f.no(), f.amount())); }
        }
        return new Run(n, total, done);
    }
    private List<LateFees.Fee> plan() { return LateFees.plan(store.overdue(), store.charged(), store.settings(), LocalDate.now(clock)); }
    private static BigDecimal total(List<LateFees.Fee> p) { return p.stream().map(LateFees.Fee::amount).reduce(BigDecimal.ZERO, BigDecimal::add); }
    /** Another run charged this month's fee first: this one's bill is rolled back. */
    static final class AlreadyCharged extends RuntimeException { private static final long serialVersionUID = 1L; AlreadyCharged() { super(null, null, false, false); } }
}
