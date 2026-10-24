package com.communityos.api.maintenance.application.port;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** What the planned works reminder needs to know: the active checklists, which rounds are done, and the reminders already sent. */
public interface PlannedWorkStore {
    record Active(UUID id, String name, String area, String frequency, Integer dueDay, Integer dueMonth, LocalDate startsOn, String assigneeRole, UUID assigneeId) {}
    List<Active> active();
    boolean done(UUID checklistId, String period);
    /** Records that this reminder was sent; false when it already was (it is sent once per checklist, period and kind). */
    boolean claim(UUID checklistId, String period, String kind);
}
