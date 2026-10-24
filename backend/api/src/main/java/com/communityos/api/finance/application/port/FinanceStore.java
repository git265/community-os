package com.communityos.api.finance.application.port;

import com.communityos.api.finance.domain.Books;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** The cash book, releases, pay requests, bank lines and the ledger views - explicit SQL behind it (JdbcFinanceStore). */
public interface FinanceStore {
    record Settings(BigDecimal approvalLimit, LocalDate lockedUntil, boolean approvalSeparate) {}
    Settings settings();
    boolean lock(LocalDate until);
    // the cash book
    record EntryFilter(LocalDate from, LocalDate to, String module, String recon, String taskRef, UUID sourceId) {}
    List<Books.Entry> entries(EntryFilter f);
    Optional<Books.Entry> entry(UUID id);
    void insert(Books.Entry e);
    /** The words on an entry (never its money): description, category, sub-category, ITC status and note. */
    boolean annotate(Books.Entry e);
    boolean setRecon(UUID entryId, String status, UUID bankTxnId);
    // releases
    List<Books.Release> releases(UUID ticketId, UUID expenseId);
    Optional<Books.Release> release(UUID id);
    void insert(Books.Release r);
    boolean update(Books.Release r);
    boolean deleteRelease(UUID id, long version);
    /** Its payment was reversed: the release is Approved (not paid) again. */
    void releaseUnpaid(UUID releaseId);
    /** A cultural expense as releases see it: what it costs, what is released on it (live releases) and paid. */
    record ExpenseMoney(UUID id, UUID eventId, String item, String status, BigDecimal amount, BigDecimal released, BigDecimal paid) {}
    Optional<ExpenseMoney> expenseMoney(UUID expenseId);
    /** A cultural expense's status follows the money paid on it: Paid once its live payments and paid releases cover the amount, Approved again
     *  when a reversal leaves it short. `how` is kept as the payment's mode. Nothing changes for an expense that is not Approved or Paid. */
    void settleExpense(UUID expenseId, String how);
    /** The cultural expense a release pays towards, if any. */
    Optional<UUID> releaseExpense(UUID releaseId);
    // pay requests
    List<Books.PayRequest> payRequests(String status);
    Optional<Books.PayRequest> payRequest(UUID id);
    void insert(Books.PayRequest p);
    boolean update(Books.PayRequest p);
    // the bank
    record LineFilter(String account, LocalDate from, LocalDate to, Boolean unmatched) {}
    List<Books.BankLine> bankLines(LineFilter f);
    Optional<Books.BankLine> bankLine(UUID id);
    /** Insert statement lines; the same line imported again is skipped. Returns how many were new. */
    int importLines(List<Books.BankLine> lines);
    boolean match(UUID lineId, UUID entryId);
    boolean unmatch(UUID lineId);
    // the ledger
    record AccountBalance(UUID id, String code, String name, String kind, boolean bank, BigDecimal debit, BigDecimal credit, BigDecimal balance) {}
    List<AccountBalance> accounts();
    record JournalLine(String accountCode, String accountName, UUID unitId, BigDecimal debit, BigDecimal credit, String narration) {}
    record JournalEntry(UUID id, String shortId, LocalDate date, String memo, String sourceType, UUID sourceId, List<JournalLine> lines) {}
    List<JournalEntry> journal(LocalDate from, LocalDate to, String accountCode);
}
