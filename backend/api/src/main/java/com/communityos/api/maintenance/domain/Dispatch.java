package com.communityos.api.maintenance.domain;

import com.communityos.api.shared.domain.Ids.MembershipId;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Dispatch of maintenance tickets (role-queue task types): a ticket goes to the next free technician of its category; with nobody free it waits in
 * the category's queue, in the order received, and the next technician to become free takes the oldest one. The same rules as the app
 * (src/lib/ticketQueue.js).
 *   free     on shift (clocked in) and not holding a ticket that is Assigned or In Progress (On Hold, waiting for parts, does not count)
 *   next     of the free ones, the one whose last job was given longest ago (never given one first), then by name
 *   nudges   not started within the category's start time: the technician, then (twice that) the technician and the facility manager;
 *            in progress for longer than the category's fix time: the same two steps
 */
public final class Dispatch {
    private Dispatch() {}
    public static final int START_WITHIN_MIN = 30;
    public static final int FIX_WITHIN_HOURS = 4;

    /** A technician of a category: on shift or not, how many tickets they hold now, when they were last given one, and what they work on. */
    public record Tech(MembershipId id, String name, boolean onShift, int busy, Instant lastAssigned, String working) {
        public boolean free() { return onShift && busy == 0; }
    }

    /** The free technician a ticket goes to, if any. */
    public static Optional<Tech> next(List<Tech> techs) {
        return techs.stream().filter(Tech::free)
            .min(Comparator.comparing((Tech t) -> t.lastAssigned() == null ? Instant.EPOCH : t.lastAssigned()).thenComparing(Tech::name));
    }

    /** How long a category allows: minutes to start, hours to fix (the defaults when the category does not say). */
    public record Limits(int startWithinMin, int fixWithinHours) {
        public static Limits of(Integer start, Integer fix) { return new Limits(start == null ? START_WITHIN_MIN : start, fix == null ? FIX_WITHIN_HOURS : fix); }
        public Duration start() { return Duration.ofMinutes(startWithinMin); }
        public Duration fix() { return Duration.ofHours(fixWithinHours); }
    }

    /** Which reminder a ticket is due now, if any: kind start or fix, stage 1 (the technician) or 2 (and the facility manager). */
    public record Due(String kind, int stage, Instant since, long minutes) {}
    public static Optional<Due> due(String status, Instant assignedAt, Instant startedAt, Limits l, Instant now) {
        if ("Assigned".equals(status) && assignedAt != null) return stage("start", assignedAt, l.start(), now);
        if ("In Progress".equals(status) && startedAt != null) return stage("fix", startedAt, l.fix(), now);
        return Optional.empty();
    }
    private static Optional<Due> stage(String kind, Instant since, Duration limit, Instant now) {
        Duration took = Duration.between(since, now);
        if (took.compareTo(limit) < 0) return Optional.empty();
        return Optional.of(new Due(kind, took.compareTo(limit.multipliedBy(2)) >= 0 ? 2 : 1, since, took.toMinutes()));
    }

    /** One reminder to send (claimed once per ticket, kind, stage and assignment). */
    public record Nudge(UUID ticketId, String shortId, String title, String category, MembershipId assignee, String assigneeName, String kind, int stage, long minutes) {}
}
