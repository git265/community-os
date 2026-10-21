package com.communityos.api.finance.application;

import com.communityos.api.finance.application.port.FinanceStore;
import com.communityos.api.finance.domain.Books;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.UUID;

/**
 * Payments above the community's approval limit: the accounts send the cash book entry as a request; a second person (another money role or a
 * final approver - never the one who asked) approves it, and then the server records the entry exactly as it was asked; or rejects it.
 */
public final class PayRequestService {
    private final FinanceStore store; private final CashBookService cash; private final com.communityos.api.approval.application.ApprovalSettings approvals; private final ObjectMapper json;
    private final AuditWriter audit; private final Tx tx;
    public PayRequestService(FinanceStore store, CashBookService cash, com.communityos.api.approval.application.ApprovalSettings approvals, ObjectMapper json, AuditWriter audit, Tx tx) {
        this.store = store; this.cash = cash; this.approvals = approvals; this.json = json; this.audit = audit; this.tx = tx;
    }

    /** What was asked, as plain text values (so it reads back exactly, whatever the JSON settings). */
    static java.util.Map<String, Object> payload(Books.Entry e) {
        java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("date", s(e.date)); m.put("account", e.account); m.put("description", e.description); m.put("category", e.category); m.put("subCategory", e.subCategory); m.put("type", e.type);
        m.put("amount", s(e.amount)); m.put("vendor", e.vendor); m.put("taskRef", e.taskRef); m.put("noTask", e.noTask); m.put("module", e.module); m.put("sourceType", e.sourceType);
        m.put("sourceLabel", e.sourceLabel); m.put("sourceId", s(e.sourceId)); m.put("mode", e.mode); m.put("ref", e.ref); m.put("unitId", s(e.unitId)); m.put("bookingNo", e.bookingNo);
        m.put("invoiceNo", e.invoiceNo); m.put("billNo", e.billNo); m.put("baseAmount", s(e.baseAmount)); m.put("gstRate", s(e.gstRate)); m.put("tdsSection", e.tdsSection); m.put("tdsRate", s(e.tdsRate));
        m.put("fund", e.fund); m.put("itcStatus", e.itcStatus); m.put("itcNote", e.itcNote);
        return m;
    }
    static Books.Entry entry(java.util.Map<String, Object> m) {
        Books.Entry e = new Books.Entry();
        e.date = d(m, "date") == null ? null : java.time.LocalDate.parse(d(m, "date")); e.account = d(m, "account"); e.description = d(m, "description"); e.category = d(m, "category");
        e.subCategory = d(m, "subCategory"); e.type = d(m, "type"); e.amount = n(m, "amount"); e.vendor = d(m, "vendor"); e.taskRef = d(m, "taskRef"); e.noTask = d(m, "noTask"); e.module = d(m, "module");
        e.sourceType = d(m, "sourceType"); e.sourceLabel = d(m, "sourceLabel"); e.sourceId = d(m, "sourceId") == null ? null : java.util.UUID.fromString(d(m, "sourceId")); e.mode = d(m, "mode");
        e.ref = d(m, "ref"); e.unitId = d(m, "unitId") == null ? null : java.util.UUID.fromString(d(m, "unitId")); e.bookingNo = d(m, "bookingNo"); e.invoiceNo = d(m, "invoiceNo"); e.billNo = d(m, "billNo");
        e.baseAmount = n(m, "baseAmount"); e.gstRate = n(m, "gstRate"); e.tdsSection = d(m, "tdsSection"); e.tdsRate = n(m, "tdsRate"); e.fund = d(m, "fund"); e.itcStatus = d(m, "itcStatus"); e.itcNote = d(m, "itcNote");
        return e;
    }
    static String s(Object o) { return o == null ? null : o.toString(); }
    static String d(java.util.Map<String, Object> m, String k) { Object v = m.get(k); return v == null ? null : v.toString(); }
    static java.math.BigDecimal n(java.util.Map<String, Object> m, String k) { String v = d(m, k); return v == null ? null : new java.math.BigDecimal(v); }

    public List<Books.PayRequest> list(Caller c, String status) { CashBookService.requireReader(c); return store.payRequests(status); }

    public Books.PayRequest submit(Caller c, Books.Entry e) {
        CashBookService.requireWriter(c);
        e.check();
        if (!e.debit()) throw new DomainException.RuleViolated("not-a-payment", "Only money out waits for a second approver");
        return tx.inTx(() -> {
            Books.PayRequest p = new Books.PayRequest();
            p.description = e.description; p.amount = e.amount; p.vendor = e.vendor; p.requestedBy = c.displayName();
            try { p.payload = json.writeValueAsString(payload(e)); } catch (Exception x) { throw new IllegalStateException(x); }
            store.insert(p);
            audit.write(c, AuditWriter.Action.Create, "finance.pay_request", p.id, p.shortId, null, "Payment of " + p.amount.toPlainString() + " waits for a second approver", List.of());
            return store.payRequest(p.id).orElseThrow();
        });
    }
    public Books.PayRequest decide(Caller c, UUID id, long version, boolean approve, String note) {
        if (!(FinancePolicy.writer(c) || approvals.settings().approvers().isFinal(c))) throw new AccessDenied("Only another money role or a final approver decides");
        if (!approve && (note == null || note.isBlank())) throw new DomainException.RuleViolated("reason-required", "Say why it is rejected");
        return tx.inTx(() -> {
            Books.PayRequest p = store.payRequest(id).orElseThrow(AccessDenied.NotVisible::new);
            if (p.version != version) throw new DomainException.Conflict("Pay request " + p.shortId);
            if (!"Waiting".equals(p.status)) throw new DomainException.RuleViolated("decided", "Already " + p.status.toLowerCase());
            if (c.membership() != null && c.membership().value().equals(p.requestedById)) throw new AccessDenied("A second person approves a payment you asked for");
            p.status = approve ? "Approved" : "Rejected"; p.decisionNote = note;
            if (approve) {
                Books.Entry e;
                try { e = entry(json.readValue(p.payload, new com.fasterxml.jackson.core.type.TypeReference<java.util.Map<String, Object>>() {})); }
                catch (Exception x) { throw new DomainException.RuleViolated("bad-request", "The request cannot be read"); }
                p.entryId = cash.recordApproved(c, e).id;
            }
            if (!store.update(p)) throw new DomainException.Conflict("Pay request " + p.shortId);
            audit.write(c, AuditWriter.Action.Update, "finance.pay_request", p.id, p.shortId, null, (approve ? "Approved" : "Rejected: " + note), List.of());
            return store.payRequest(id).orElseThrow();
        });
    }
}
