package com.communityos.api.finance.application;

import com.communityos.api.maintenance.application.TicketRules;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;

/** Who reads and writes the community's own books. */
public final class FinancePolicy {
    private FinancePolicy() {}
    /** Reads the cash book: the committee, the Facility Manager and the money roles. */
    public static boolean reader(Caller c) {
        return c.isSuperAdmin() || c.isCommittee() || c.roleCodes().contains("facility_manager") || c.hasAny(Permission.MANAGE_LEDGER, Permission.MANAGE_DUES, Permission.MANAGE_UTILITY_BILLING);
    }
    /** Writes the cash book, imports and matches bank statements, closes the books. */
    public static boolean writer(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_LEDGER); }
    /** Raises releases on tasks (the queue's coordinators and the accounts) or on event expenses (also the cultural committee). */
    public static boolean raisesRelease(Caller c, boolean cultural) { return TicketRules.coordinator(c) || writer(c) || (cultural && c.has(Permission.MANAGE_CULTURAL)); }
    /** Pays approved releases and cancels unpaid ones: the committee and the accounts. */
    public static boolean paysRelease(Caller c) { return c.isCommittee() || writer(c); }
}
