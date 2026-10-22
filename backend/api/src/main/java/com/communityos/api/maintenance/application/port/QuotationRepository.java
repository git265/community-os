package com.communityos.api.maintenance.application.port;

import com.communityos.api.maintenance.domain.Quotation;
import com.communityos.api.maintenance.domain.Ticket;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port: quotations and invoices, and the money summary they write on their task. */
public interface QuotationRepository {
    List<Quotation> ofTicket(UUID ticketId);
    /** Every document on the tickets in this scope (the ticket specification on alias t). */
    List<Quotation> all(com.communityos.api.shared.access.Spec<Ticket> ticketScope);
    Optional<Quotation> get(UUID id);
    void insert(Quotation q);
    boolean save(Quotation q);
    boolean delete(UUID id, long version);
    /** Files attached to the quotation or invoice (its document). */
    int files(UUID id);
    /** Write the money summary on the task (bumps its version). */
    void saveTicketApproval(UUID ticketId, Ticket.Approval a);
}
