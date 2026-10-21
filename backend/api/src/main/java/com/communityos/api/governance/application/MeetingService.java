package com.communityos.api.governance.application;

import com.communityos.api.governance.application.port.GovernanceStore;
import com.communityos.api.governance.domain.Governance;
import com.communityos.api.governance.domain.Governance.Meeting;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * Meetings: the committee schedules them (internal until published), publishes them to residents, writes the minutes once they have been held,
 * completes or cancels them. Residents see only published meetings and are told when one is published, moved, cancelled or its minutes are out.
 * A meeting that was published or has minutes is never deleted - it is cancelled.
 */
public final class MeetingService {
    public record Fields(String title, String committee, LocalDate date, LocalTime startTime, LocalTime endTime, String location, String status, String visibility,
                         String agenda, String minutes, String cancelReason) {}
    public record MeetingEvent(String topic, UUID aggregateId, CommunityId communityId, String title, String detail, Instant occurredAt) implements DomainEvent {}

    private final GovernanceStore store; private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock; private final ZoneId zone;
    public MeetingService(GovernanceStore store, DomainEvents events, AuditWriter audit, Tx tx, Clock clock, ZoneId zone) {
        this.store = store; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock; this.zone = zone;
    }

    public List<Meeting> list(Caller c, LocalDate from, LocalDate to, String committee) {
        if (!GovernancePolicy.member(c)) throw new AccessDenied("Members only");
        return store.meetings(new GovernanceStore.MeetingFilter(!GovernancePolicy.insider(c), from, to, committee));
    }
    public Meeting get(Caller c, UUID id) {
        if (!GovernancePolicy.member(c)) throw new AccessDenied.NotVisible();
        Meeting m = store.meeting(id, false).orElseThrow(AccessDenied.NotVisible::new);
        if (!GovernancePolicy.insider(c) && !m.published()) throw new AccessDenied.NotVisible();
        return m;
    }

    public Meeting create(Caller c, Fields f) {
        manager(c);
        return tx.inTx(() -> {
            Meeting m = new Meeting();
            m.id = UUID.randomUUID();
            List<DomainEvent> out = apply(c, null, m, f);
            store.insert(m);
            audit.write(c, AuditWriter.Action.Create, "governance.meeting", m.id, m.shortId, null, "Meeting " + m.title + " on " + m.date, List.of());
            publish(c, m, out);
            return m;
        });
    }

    public Meeting update(Caller c, UUID id, long version, Fields f) {
        manager(c);
        return tx.inTx(() -> {
            Meeting m = store.meeting(id, true).orElseThrow(() -> new DomainException.NotFound("Meeting"));
            if (m.version != version) throw new DomainException.Conflict("The meeting");
            Meeting old = copy(m);
            List<DomainEvent> out = apply(c, old, m, f);
            if (!store.update(m)) throw new DomainException.Conflict("The meeting");
            audit.write(c, AuditWriter.Action.Update, "governance.meeting", m.id, m.shortId, null, "Meeting " + m.title + ": " + summary(old, m), List.of());
            publish(c, m, out);
            return m;
        });
    }

    public void delete(Caller c, UUID id, long version) {
        manager(c);
        tx.run(() -> {
            Meeting m = store.meeting(id, true).orElseThrow(() -> new DomainException.NotFound("Meeting"));
            if (m.publishedAt != null || m.minutes != null)
                throw new DomainException.RuleViolated("keep-meeting", "A meeting that was published or has minutes stays on record - cancel it instead");
            if (!store.deleteMeeting(id, version)) throw new DomainException.Conflict("The meeting");
            audit.write(c, AuditWriter.Action.Delete, "governance.meeting", m.id, m.shortId, null, "Deleted meeting " + m.title, List.of());
        });
    }

    /** Copies the fields in, checks them against what the meeting was and today, and says what residents should hear. */
    List<DomainEvent> apply(Caller c, Meeting old, Meeting m, Fields f) {
        LocalDate today = LocalDate.now(clock.withZone(zone));
        Instant now = clock.instant();
        m.title = trim(f.title()); m.committee = trim(f.committee()); m.date = f.date(); m.startTime = f.startTime(); m.endTime = f.endTime(); m.location = trim(f.location());
        m.status = f.status() == null ? (old == null ? "Scheduled" : old.status) : f.status();
        m.visibility = f.visibility() == null ? (old == null ? Governance.INTERNAL : old.visibility) : f.visibility();
        m.agenda = f.agenda(); m.minutes = f.minutes(); m.cancelReason = "Cancelled".equals(m.status) ? trim(f.cancelReason()) : null;
        m.check();
        String was = old == null ? null : old.status;
        if ("Completed".equals(m.status) && m.date.isAfter(today)) throw new DomainException.RuleViolated("not-held", "A meeting is completed once it has been held (" + m.date + ")");
        if ("Completed".equals(was) && "Scheduled".equals(m.status)) throw new DomainException.RuleViolated("completed", "A completed meeting stays completed");
        if ("Cancelled".equals(was) && "Completed".equals(m.status)) throw new DomainException.RuleViolated("cancelled", "A cancelled meeting was not held - schedule it again first");
        boolean minutesChanged = !Objects.equals(m.minutes, old == null ? null : old.minutes);
        if (m.minutes != null && minutesChanged) {
            if ("Cancelled".equals(m.status)) throw new DomainException.RuleViolated("cancelled", "A cancelled meeting has no minutes");
            if (m.date.isAfter(today)) throw new DomainException.RuleViolated("not-held", "Minutes are written after the meeting (" + m.date + ")");
            m.minutesAt = now; m.minutesById = c.membership().value();
        } else if (m.minutes == null) { m.minutesAt = null; m.minutesById = null; }
        boolean wasPublished = old != null && old.published();
        if (m.published() && m.publishedAt == null) { m.publishedAt = now; m.publishedById = c.membership().value(); }
        // unpublished: residents no longer see it (and are not told); the first publishing time stays on record

        List<DomainEvent> out = new ArrayList<>();
        if (!m.published()) return out;
        String when = m.date + " " + m.startTime + (m.location == null ? "" : " · " + m.location);
        if (!wasPublished) out.add(event(c, "governance.meeting.published", m, "Meeting: " + m.title, when));
        else {
            if ("Cancelled".equals(m.status) && !"Cancelled".equals(was)) out.add(event(c, "governance.meeting.cancelled", m, "Cancelled: " + m.title, m.cancelReason == null ? when : m.cancelReason));
            else if (!"Cancelled".equals(m.status) && (!Objects.equals(m.date, old.date) || !Objects.equals(m.startTime, old.startTime) || !Objects.equals(m.location, old.location)))
                out.add(event(c, "governance.meeting.changed", m, "Meeting moved: " + m.title, "Now " + when));
        }
        if (wasPublished && old.minutes == null && m.minutes != null)
            out.add(event(c, "governance.meeting.minutes", m, "Minutes: " + m.title, "The minutes of the meeting on " + m.date + " are out."));
        return out;
    }

    private MeetingEvent event(Caller c, String topic, Meeting m, String title, String detail) { return new MeetingEvent(topic, m.id, c.community(), title, detail, clock.instant()); }
    private void publish(Caller c, Meeting m, List<DomainEvent> out) {
        if (out.isEmpty()) return;
        events.publish(out);
    }
    static void manager(Caller c) { if (!GovernancePolicy.manager(c)) throw new AccessDenied("Only the committee runs meetings"); }
    static String trim(String s) { return s == null || s.isBlank() ? null : s.strip(); }
    static Meeting copy(Meeting m) {
        Meeting o = new Meeting();
        o.id = m.id; o.shortId = m.shortId; o.title = m.title; o.committee = m.committee; o.date = m.date; o.startTime = m.startTime; o.endTime = m.endTime; o.location = m.location;
        o.status = m.status; o.visibility = m.visibility; o.publishedAt = m.publishedAt; o.publishedById = m.publishedById; o.agenda = m.agenda; o.minutes = m.minutes;
        o.minutesAt = m.minutesAt; o.minutesById = m.minutesById; o.cancelReason = m.cancelReason; o.version = m.version;
        return o;
    }
    static String summary(Meeting o, Meeting m) {
        List<String> s = new ArrayList<>();
        if (!Objects.equals(o.status, m.status)) s.add(o.status + " → " + m.status);
        if (!Objects.equals(o.visibility, m.visibility)) s.add(m.published() ? "published" : "made internal");
        if (!Objects.equals(o.date, m.date) || !Objects.equals(o.startTime, m.startTime)) s.add("moved to " + m.date + " " + m.startTime);
        if (!Objects.equals(o.minutes, m.minutes)) s.add(m.minutes == null ? "minutes removed" : "minutes");
        if (!Objects.equals(o.agenda, m.agenda)) s.add("agenda");
        return s.isEmpty() ? "edited" : String.join(", ", s);
    }
}
