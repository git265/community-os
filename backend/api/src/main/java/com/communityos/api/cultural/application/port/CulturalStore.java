package com.communityos.api.cultural.application.port;

import com.communityos.api.cultural.domain.Cultural;
import com.communityos.api.shared.access.Spec;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Donations, expenses, sign-ups and offering reservations - explicit SQL behind it (JdbcCulturalStore). */
public interface CulturalStore {
    /** The event, locked for the rest of the transaction when lock is true (receipt numbers, totals). */
    Optional<Cultural.Event> event(UUID id, boolean lock);
    boolean credit(UUID eventId, long version, java.math.BigDecimal amount, String note);
    // donations
    List<Cultural.Donation> donations(Spec<Cultural.Donation> scope, UUID eventId);
    Optional<Cultural.Donation> donation(UUID id, Spec<Cultural.Donation> scope);
    void insert(Cultural.Donation d);
    boolean update(Cultural.Donation d);
    boolean delete(UUID id, long version);
    /** The highest receipt number used for this code ("GC26-0007" -> 7). */
    int lastReceipt(String code);
    // offerings
    record Offering(UUID id, UUID eventId, String title, String day, String kind, java.math.BigDecimal pledgeValue, UUID donationId) {}
    Optional<Offering> offering(UUID id);
    /** Reserve a free fixed slot for a pledge (false: someone else holds it). */
    boolean reserve(UUID offeringId, UUID donationId, String by, UUID unitId);
    void release(UUID donationId);
    // expenses
    List<Cultural.Expense> expenses(UUID eventId);
    Optional<Cultural.Expense> expense(UUID id);
    void insert(Cultural.Expense x);
    boolean update(Cultural.Expense x);
    boolean deleteExpense(UUID id, long version);
    // sign-ups (a seva slot's volunteers, a programme item's participants)
    enum List_ { SEVA, PROGRAM }
    record Slot(UUID id, UUID eventId, String title, int limit, int peoplePerUnit, List<Cultural.Signup> list, long version) {}
    Optional<Slot> slot(List_ which, UUID id, boolean lock);
    boolean saveList(List_ which, UUID id, List<Cultural.Signup> list);
    String unitNo(UUID unitId);
    /** For files on a photo / brochure page: is its event published, and who added the row. */
    record Owner(boolean published, UUID addedBy) {}
    Optional<Owner> photo(UUID id);
    Optional<Owner> brochure(UUID id);
}
