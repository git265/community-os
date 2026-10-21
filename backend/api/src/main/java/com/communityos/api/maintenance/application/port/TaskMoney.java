package com.communityos.api.maintenance.application.port;

import com.communityos.api.shared.domain.Money;
import java.util.UUID;

/**
 * Port: the money position of a task - what is approved (invoice, else the approved quotation), what is released or paid against it, and what is
 * left. Releases and payments live in finance; this is how maintenance asks before it changes an approval, closes or cancels the task.
 */
public interface TaskMoney {
    /** basis = Invoice | Quotation | None; remaining is null while nothing is approved. */
    record Position(String basis, Money cap, Money invoiceApproved, Money quoted, Money released, Money direct, Money paid, Money committed, Money remaining, int openReleases) {}
    Position position(UUID ticketId);
    /** Live payments recorded against one document (an invoice / a quotation). */
    Money paidOn(UUID documentId);
}
