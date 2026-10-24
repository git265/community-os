package com.communityos.api.comms.domain;

import com.communityos.api.shared.domain.DomainException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Notices, notifications and the forum: the words the module uses and the rules that need no database.
 *   - a notification is one row per person in their inbox; the server writes it from what happened (never the browser)
 *   - a notice (broadcast) goes to an audience once; a receipt per person records delivery, viewing and signing
 *   - a poll on a notice takes one vote per unit (people without a unit vote for themselves); a forum poll one per person
 */
public final class Comms {
    private Comms() {}

    public static final List<String> TYPES = List.of("Announcement", "Emergency alert", "Notice", "Scheduled maintenance", "Poll");
    public static final List<String> AUDIENCES = List.of("All residents", "Owners", "All villas", "All apartments", "Selected villas", "Selected apartments", "Selected blocks",
        "EC members", "Staff");
    public static final List<String> REMINDERS = List.of("None", "Daily", "Every 3 days", "Weekly");
    public static final List<String> CHANNELS = List.of("WhatsApp", "SMS", "Email");
    public static final List<String> FORUM_CATEGORIES = List.of("General", "Amenities", "Security", "Cultural Committee", "Maintenance");
    /** The kinds of notification a person and the community choose channels for (the same ids as the app's channel settings). */
    public static final List<String> EVENTS = List.of("ticket_assigned", "ticket_status", "ticket_decision", "approval", "bill", "payment_reminder", "announcement", "ticket_new",
        "ticket_chat", "ticket_overdue", "payment_made", "ballot", "ballot_result", "poll", "forum_topic", "forum_reply", "calendar", "cultural", "brochure", "service_notice", "meeting", "shift",
        "event_work", "report", "gate_approval", "gate_guest_arrived", "gate_guest_exit", "gate_delivery", "gate_staff_inout", "gate_crew_inout", "gate_overstay", "gate_ghost",
        "gate_override", "gate_blocked", "gate_vetting", "amenity_booking", "stock_low", "money_check");

    // ---- the inbox -------------------------------------------------------------------------------------------------------------------------------
    /** Who a notification is for: members by id, everyone with portal access to some units, and holders of some roles (by code; EC_MEMBERS = every committee role). */
    public record To(Set<UUID> members, Set<UUID> units, Set<String> roles, Set<String> relations) {
        public To { members = Set.copyOf(members); units = Set.copyOf(units); roles = Set.copyOf(roles); relations = relations == null ? Set.of() : Set.copyOf(relations); }
        public To(Set<UUID> members, Set<UUID> units, Set<String> roles) { this(members, units, roles, Set.of()); }
        /** Only the unit's people with these relations (Owner, Co-owner, Tenant ...): a bill reaches whoever it is billed to. */
        public static To unitPeople(UUID u, Set<String> relations) { return u == null ? nobody() : new To(Set.of(), Set.of(u), Set.of(), relations); }
        /** Who a unit's bill reaches: the owners and co-owners, or the tenants when the bill is the tenant's. */
        public static To billed(UUID u, String billTo) { return unitPeople(u, "Tenant".equals(billTo) ? Set.of("Tenant") : Set.of("Owner", "Co-owner")); }
        public static To member(UUID m) { return m == null ? nobody() : new To(Set.of(m), Set.of(), Set.of()); }
        public static To unit(UUID u) { return u == null ? nobody() : new To(Set.of(), Set.of(u), Set.of()); }
        public static To roles(String... codes) { return new To(Set.of(), Set.of(), Set.of(codes)); }
        public static To nobody() { return new To(Set.of(), Set.of(), Set.of()); }
        public static To units(java.util.Collection<UUID> us) { return new To(Set.of(), Set.copyOf(us), Set.of()); }
        /** Holders of any committee (EC) role - an approval step for "EC members". */
        public static final String EC_MEMBERS = "@ec";
        public To and(To o) {
            Set<UUID> m = new LinkedHashSet<>(members); m.addAll(o.members); Set<UUID> u = new LinkedHashSet<>(units); u.addAll(o.units);
            Set<String> r = new LinkedHashSet<>(roles); r.addAll(o.roles);
            Set<String> rel = relations.isEmpty() || o.relations.isEmpty() ? Set.of() : new LinkedHashSet<>(relations);   // a filter only when both had one
            if (!rel.isEmpty()) rel.addAll(o.relations);
            return new To(m, u, r, rel);
        }
        public boolean empty() { return members.isEmpty() && units.isEmpty() && roles.isEmpty(); }
    }
    /** One message to deliver: in the inbox always, and on the extra channels each person chose and the community offers for this event. */
    public record Message(String event, String kind, String title, String body, String link, UUID refId, To to) {
        public Message {
            if (!EVENTS.contains(event)) throw new IllegalArgumentException("unknown notification event " + event);
            title = clip(title, 200); body = clip(body == null ? "" : body, 4000);
            if (link != null && !link.startsWith("#/")) throw new IllegalArgumentException("a notification links only to a page of the app");
        }
    }
    /** An inbox row as its addressee sees it. */
    public record Note(UUID id, Instant createdAt, String event, String kind, String title, String body, String link, UUID refId, String sender, Instant readAt) {}

    // ---- notices -----------------------------------------------------------------------------------------------------------------------------------
    public static final class Broadcast {
        public UUID id; public String shortId; public String type; public String audience; public String subject; public String message;
        public List<UUID> audienceUnits = List.of(); public List<UUID> audienceBlocks = List.of();
        public LocalDate eventDate; public String startTime; public String endTime; public String affects;
        public List<String> pollOptions = List.of(); public boolean pollMultiple; public LocalDate pollClosesOn;
        public boolean requiresSignature; public String reminderFrequency = "None";
        public String status = "Draft"; public Instant sentAt; public UUID sentById; public String sentBy; public Instant scheduledFor;
        public int recipients; public int viewed; public int signed; public int pushDelivered;
        public Instant viewedAt; public Instant signedAt;          // the reader's own receipt (null for the committee's view)
        public List<String> signedBy = List.of();                   // names of who signed (the committee's view only)
        public Instant createdAt; public long version;

        public boolean poll() { return "Poll".equals(type); }
        public boolean sent() { return "Sent".equals(status); }
        public boolean pollOpen(LocalDate today) { return poll() && sent() && (pollClosesOn == null || !today.isAfter(pollClosesOn)); }

        /** Check a draft before it is saved or sent. */
        public void check() {
            rule(subject != null && !subject.isBlank(), "subject-required", poll() ? "The poll question is required" : "The subject is required");
            rule(subject.length() <= 200, "subject-too-long", "Keep the subject to 200 characters");
            rule(TYPES.contains(type), "bad-type", "Type must be one of: " + String.join(", ", TYPES));
            rule(AUDIENCES.contains(audience), "bad-audience", "Audience must be one of: " + String.join(", ", AUDIENCES));
            rule(REMINDERS.contains(reminderFrequency), "bad-reminder", "Reminders: " + String.join(", ", REMINDERS));
            rule(message == null || message.length() <= 20_000, "message-too-long", "The message is too long");
            rule(poll() || (message != null && !message.replaceAll("<[^>]*>", "").isBlank()), "message-required", "The message is required");
            if (audience.startsWith("Selected villas") || audience.startsWith("Selected apartments")) rule(!audienceUnits.isEmpty(), "units-required", "Choose at least one unit");
            if ("Selected blocks".equals(audience)) rule(!audienceBlocks.isEmpty(), "blocks-required", "Choose at least one block");
            if ("Scheduled maintenance".equals(type)) {
                rule(eventDate != null, "date-required", "Choose the maintenance date");
                rule(startTime != null && startTime.matches("\\d{2}:\\d{2}"), "start-required", "Give the start time");
                rule(endTime == null || endTime.isBlank() || (endTime.matches("\\d{2}:\\d{2}") && endTime.compareTo(startTime) > 0), "bad-times", "The end time must be after the start time");
            }
            if (poll()) {
                List<String> clean = new ArrayList<>();
                for (String o : pollOptions) if (o != null && !o.isBlank()) clean.add(o.strip());
                rule(clean.size() >= 2, "poll-options", "A poll needs at least two answers");
                rule(clean.size() <= 12, "poll-options", "A poll has at most 12 answers");
                rule(clean.stream().map(String::toLowerCase).distinct().count() == clean.size(), "poll-options", "Poll answers must be different from each other");
                pollOptions = List.copyOf(clean);
            } else pollOptions = List.of();
        }
        /** The choices of one vote, checked against this poll ("0", "2" - indexes of the answers). */
        public List<String> choices(List<String> picked, LocalDate today) {
            rule(poll(), "not-a-poll", "This notice is not a poll");
            rule(pollOpen(today), "poll-closed", "This poll is closed");
            List<String> out = new ArrayList<>(new LinkedHashSet<>(picked == null ? List.of() : picked));
            rule(!out.isEmpty(), "choose", "Choose at least one answer");
            rule(pollMultiple || out.size() == 1, "one-answer", "Choose one answer");
            for (String c : out) rule(c.matches("\\d{1,2}") && Integer.parseInt(c) < pollOptions.size(), "bad-choice", "That is not one of the answers");
            return out;
        }
        /** Who a notice is sent to, as a recipient query (the units and blocks were checked when it was saved). */
        public Audience reach() { return new Audience(audience, audienceUnits, audienceBlocks); }
    }
    public record Audience(String kind, List<UUID> units, List<UUID> blocks) {}
    /** A poll's answers: votes per answer (by index), how many voted, and the reader's own choices. */
    public record PollResult(List<Integer> counts, int total, List<String> mine, String mineBy) {}

    // ---- forum ---------------------------------------------------------------------------------------------------------------------------------------
    public static final class Topic {
        public UUID id; public String shortId; public String title; public String category = "General"; public String kind = "Discussion"; public List<String> pollOptions = List.of();
        public boolean pinned; public String status = "Open"; public int replies; public UUID authorId; public String author; public Instant lastPostAt; public Instant createdAt; public long version;
        public boolean open() { return "Open".equals(status); }
        public void check() {
            rule(title != null && title.strip().length() >= 3, "title-required", "Give the topic a title (3 characters or more)");
            rule(title.strip().length() <= 200, "title-too-long", "Keep the title to 200 characters");
            title = title.strip();
            rule(FORUM_CATEGORIES.contains(category), "bad-category", "Category must be one of: " + String.join(", ", FORUM_CATEGORIES));
            rule(List.of("Discussion", "Poll").contains(kind), "bad-kind", "A topic is a discussion or a poll");
            if ("Poll".equals(kind)) {
                List<String> clean = pollOptions.stream().filter((o) -> o != null && !o.isBlank()).map(String::strip).toList();
                pollOptions = clean.isEmpty() ? List.of("Yes", "No") : clean;
                rule(pollOptions.size() >= 2 && pollOptions.size() <= 12, "poll-options", "A poll has 2 to 12 answers");
                rule(pollOptions.stream().map(String::toLowerCase).distinct().count() == pollOptions.size(), "poll-options", "Poll answers must be different from each other");
            } else pollOptions = List.of();
        }
    }
    public static final class Post {
        public UUID id; public String shortId; public UUID topicId; public UUID parentId; public UUID authorId; public String author; public String authorRole; public String body;
        public int reactions; public boolean hidden; public String hiddenReason; public Instant editedAt; public Instant createdAt; public long version;
        public static String checkBody(String body) {
            String b = body == null ? "" : body.strip();
            rule(!b.replaceAll("<[^>]*>", "").isBlank(), "body-required", "Write something first");
            rule(b.length() <= 5000, "body-too-long", "Keep a post to 5000 characters");
            return b;
        }
    }

    static String clip(String s, int max) { return s == null ? null : s.length() <= max ? s : s.substring(0, max - 1) + "…"; }
    static void rule(boolean ok, String code, String message) { if (!ok) throw new DomainException.RuleViolated(code, message); }
}
