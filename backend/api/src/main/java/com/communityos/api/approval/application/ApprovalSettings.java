package com.communityos.api.approval.application;

import com.communityos.api.approval.domain.Policy;
import java.math.BigDecimal;
import java.util.List;

/** Port: the community's approval rules and settings (approval policies, final approvers, finance settings). */
public interface ApprovalSettings {
    /** The settings that change how invoices and approvals behave. */
    record Settings(Approvers approvers, BigDecimal invoiceTolerancePct, boolean invoiceSkipWithinQuote) {}
    List<Policy> policies();
    Settings settings();
}
