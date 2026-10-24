package com.communityos.api.maintenance.application.port;

import com.communityos.api.maintenance.domain.Dispatch;
import com.communityos.api.shared.domain.Ids.MembershipId;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** What dispatch reads and claims, inside the caller's community (the tenant connection). */
public interface DispatchStore {
    /** The field staff of a category, with their load now. */
    List<Dispatch.Tech> techs(String category);
    /** Hold the category's queue for this transaction (two dispatches of one category never give one technician two tickets). */
    void lock(String category);
    /** The category's queue: open, unassigned role-queue tickets, oldest first. */
    List<UUID> queued(String category, int limit);
    /** The categories that have a queue now. */
    List<String> queuedCategories();
    /** Tickets given to a technician who is off shift now and never started: they go back to the queue. */
    List<UUID> offShiftAssigned();

    /** A ticket being worked on, with its category's limits: for the reminders. */
    record Active(UUID id, String shortId, String title, String category, String status, MembershipId assignee, String assigneeName, Instant assignedAt, Instant startedAt,
                  Integer startWithinMin, Integer fixWithinHours) {}
    List<Active> active();
    /** Claim a reminder (once per ticket, kind, stage and assignment); true when this call claimed it. */
    boolean claim(UUID ticket, String kind, int stage, Instant since);

    /** A ticket of a category's queue view. */
    record Row(UUID id, String shortId, String title, String category, String priority, String status, UUID unitId, String unitNo, MembershipId raisedBy, UUID assigneeId,
               String assigneeName, Instant createdAt, Instant assignedAt, Instant startedAt, Instant completedAt) {}
    /** A category's role-queue tickets received since `since`, and every one still open whenever received, in the order received. */
    List<Row> queueView(String category, Instant since);
}
