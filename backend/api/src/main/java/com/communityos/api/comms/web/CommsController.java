package com.communityos.api.comms.web;

import com.communityos.api.comms.application.BroadcastService;
import com.communityos.api.comms.application.ForumService;
import com.communityos.api.comms.application.InboxService;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The inbox, notices (with receipts and polls) and the forum. Each request type lists exactly what a person may send for that step. */
@RestController
@Tag(name = "Communications")
public class CommsController {
    // ---- request types ---------------------------------------------------------------------------------------------------------------------------
    /** A notice as the committee writes it; who it reached, counts, status and the sender are the server's. */
    public record DraftRequest(@Size(max = 30) String type, @Size(max = 30) String audience, @NotBlank @Size(max = 200) String subject, @Size(max = 20_000) String message,
                               @Size(max = 5000) List<UUID> unitIds, @Size(max = 200) List<UUID> blockIds, LocalDate eventDate, @Pattern(regexp = "\\d{2}:\\d{2}") String startTime,
                               @Pattern(regexp = "(\\d{2}:\\d{2})?") String endTime, @Size(max = 300) String affects, @Size(max = 12) List<@Size(max = 200) String> pollOptions,
                               Boolean pollMultiple, LocalDate pollClosesOn, Boolean requiresSignature, @Size(max = 20) String reminderFrequency) {
        BroadcastService.Draft draft() {
            return new BroadcastService.Draft(type, audience, subject, message, unitIds, blockIds, eventDate, startTime, endTime, affects, pollOptions, pollMultiple, pollClosesOn,
                requiresSignature, reminderFrequency);
        }
    }
    public record CreateRequest(@NotNull @Valid DraftRequest notice, Boolean send, Instant scheduleFor) {}
    public record ScheduleRequest(Instant at) {}
    public record RescheduleRequest(@NotNull LocalDate eventDate, @NotNull @Pattern(regexp = "\\d{2}:\\d{2}") String startTime, @Pattern(regexp = "(\\d{2}:\\d{2})?") String endTime) {}
    public record VoteRequest(@NotNull @Size(min = 1, max = 12) List<@Pattern(regexp = "\\d{1,2}") String> choices, UUID unitId) {}
    public record TopicRequest(@NotBlank @Size(max = 200) String title, @Size(max = 40) String category, @Pattern(regexp = "Discussion|Poll") String kind,
                               @Size(max = 12) List<@Size(max = 200) String> pollOptions) {}
    public record TopicChangeRequest(@Size(max = 200) String title, @Size(max = 40) String category, Boolean pinned, @Pattern(regexp = "Open|Closed") String status) {}
    public record PostRequest(UUID parentId, @NotBlank @Size(max = 5000) String body) {}
    public record EditRequest(@NotBlank @Size(max = 5000) String body) {}
    public record HideRequest(@NotNull Boolean hidden, @Size(max = 500) String reason) {}
    public record TopicVoteRequest(@NotNull @Min(0) @Max(11) Integer choice) {}

    // ---- responses -------------------------------------------------------------------------------------------------------------------------------
    public record BroadcastResponse(UUID id, String shortId, String type, String audience, String subject, String message, List<UUID> unitIds, List<UUID> blockIds,
                                    LocalDate eventDate, String startTime, String endTime, String affects, List<String> pollOptions, boolean pollMultiple, LocalDate pollClosesOn,
                                    boolean requiresSignature, String reminderFrequency, String status, Instant scheduledFor, Instant sentAt, String sentBy, int recipients,
                                    int viewed, int signed, int pushDelivered, List<String> signedBy, Instant viewedAt, Instant signedAt, Instant createdAt, long version) {
        static BroadcastResponse of(Comms.Broadcast b) {
            return new BroadcastResponse(b.id, b.shortId, b.type, b.audience, b.subject, b.message, b.audienceUnits, b.audienceBlocks, b.eventDate, b.startTime, b.endTime, b.affects,
                b.pollOptions, b.pollMultiple, b.pollClosesOn, b.requiresSignature, b.reminderFrequency, b.status, b.scheduledFor, b.sentAt, b.sentBy, b.recipients, b.viewed, b.signed,
                b.pushDelivered, b.signedBy, b.viewedAt, b.signedAt, b.createdAt, b.version);
        }
    }
    public record TopicResponse(UUID id, String shortId, String title, String category, String kind, List<String> pollOptions, boolean pinned, String status, int replies,
                                UUID authorId, String author, Instant lastPostAt, Instant createdAt, long version) {
        static TopicResponse of(Comms.Topic t) {
            return new TopicResponse(t.id, t.shortId, t.title, t.category, t.kind, t.pollOptions, t.pinned, t.status, t.replies, t.authorId, t.author, t.lastPostAt, t.createdAt, t.version);
        }
    }
    public record PostResponse(UUID id, String shortId, UUID topicId, UUID parentId, UUID authorId, String author, String authorRole, String body, int reactions, boolean hidden,
                               String hiddenReason, Instant editedAt, Instant createdAt, long version) {
        static PostResponse of(Comms.Post p) {
            return new PostResponse(p.id, p.shortId, p.topicId, p.parentId, p.authorId, p.author, p.authorRole, p.body, p.reactions, p.hidden, p.hiddenReason, p.editedAt, p.createdAt, p.version);
        }
    }

    private final InboxService inbox; private final BroadcastService notices; private final ForumService forum;
    public CommsController(InboxService inbox, BroadcastService notices, ForumService forum) { this.inbox = inbox; this.notices = notices; this.forum = forum; }

    // ---- the inbox ---------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/notifications")
    public List<Comms.Note> mine(@RequestParam(defaultValue = "false") boolean unread, @RequestParam(defaultValue = "100") int limit) { return inbox.mine(CallerHolder.require(), unread, limit); }
    @GetMapping("/api/v1/notifications/unread-count")
    public Map<String, Integer> unread() { return Map.of("count", inbox.unread(CallerHolder.require())); }
    @PostMapping("/api/v1/notifications/{id}/read")
    public Map<String, Integer> read(@PathVariable UUID id) { return Map.of("changed", inbox.markRead(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/notifications/read-all")
    public Map<String, Integer> readAll() { return Map.of("changed", inbox.markAllRead(CallerHolder.require())); }

    // ---- notices ---------------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/comms/broadcasts")
    public List<BroadcastResponse> broadcasts(@RequestParam(required = false) String status) { return notices.list(CallerHolder.require(), status).stream().map(BroadcastResponse::of).toList(); }
    @GetMapping("/api/v1/comms/broadcasts/{id}")
    public ResponseEntity<BroadcastResponse> broadcast(@PathVariable UUID id) { return tagged(notices.get(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/comms/broadcasts/reach")
    public Map<String, Integer> reach(@Valid @RequestBody DraftRequest b) { return Map.of("people", notices.reach(CallerHolder.require(), b.draft())); }
    @PostMapping("/api/v1/comms/broadcasts")
    public ResponseEntity<BroadcastResponse> create(@Valid @RequestBody CreateRequest b) {
        Comms.Broadcast x = notices.create(CallerHolder.require(), b.notice().draft(), Boolean.TRUE.equals(b.send()), b.scheduleFor());
        return ResponseEntity.status(201).header("ETag", ETags.of(x.version)).body(BroadcastResponse.of(x));
    }
    @PutMapping("/api/v1/comms/broadcasts/{id}")
    public ResponseEntity<BroadcastResponse> update(@PathVariable UUID id, @Valid @RequestBody DraftRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(notices.update(CallerHolder.require(), id, ETags.require(ifMatch), b.draft()));
    }
    @PostMapping("/api/v1/comms/broadcasts/{id}/send")
    public ResponseEntity<BroadcastResponse> send(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(notices.send(CallerHolder.require(), id, ETags.require(ifMatch)));
    }
    @PostMapping("/api/v1/comms/broadcasts/{id}/schedule")
    public ResponseEntity<BroadcastResponse> schedule(@PathVariable UUID id, @RequestBody ScheduleRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(notices.schedule(CallerHolder.require(), id, ETags.require(ifMatch), b.at()));
    }
    @PostMapping("/api/v1/comms/broadcasts/{id}/reschedule")
    public ResponseEntity<BroadcastResponse> reschedule(@PathVariable UUID id, @Valid @RequestBody RescheduleRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(notices.reschedule(CallerHolder.require(), id, ETags.require(ifMatch), b.eventDate(), b.startTime(), b.endTime()));
    }
    @DeleteMapping("/api/v1/comms/broadcasts/{id}")
    public ResponseEntity<Void> remove(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        notices.remove(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }
    @PostMapping("/api/v1/comms/broadcasts/{id}/view")
    public ResponseEntity<BroadcastResponse> view(@PathVariable UUID id) { return tagged(notices.view(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/comms/broadcasts/{id}/sign")
    public ResponseEntity<BroadcastResponse> sign(@PathVariable UUID id) { return tagged(notices.sign(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/comms/broadcasts/{id}/vote")
    public Comms.PollResult vote(@PathVariable UUID id, @Valid @RequestBody VoteRequest b) { return notices.vote(CallerHolder.require(), id, b.choices(), b.unitId()); }
    @GetMapping("/api/v1/comms/broadcasts/polls")
    public java.util.Map<UUID, BroadcastService.PollView> polls() { return notices.polls(CallerHolder.require()); }
    @GetMapping("/api/v1/comms/broadcasts/{id}/results")
    public Comms.PollResult results(@PathVariable UUID id) { return notices.results(CallerHolder.require(), id); }
    @GetMapping("/api/v1/comms/broadcasts/{id}/voters")
    public List<BroadcastService.Voter> voters(@PathVariable UUID id) { return notices.voters(CallerHolder.require(), id); }

    // ---- forum -----------------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/comms/forum/topics")
    public List<TopicResponse> topics(@RequestParam(required = false) String category) { return forum.topics(CallerHolder.require(), category).stream().map(TopicResponse::of).toList(); }
    @GetMapping("/api/v1/comms/forum/topics/{id}")
    public TopicResponse topic(@PathVariable UUID id) { return TopicResponse.of(forum.topic(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/comms/forum/topics")
    public ResponseEntity<TopicResponse> start(@Valid @RequestBody TopicRequest b) {
        Comms.Topic t = forum.start(CallerHolder.require(), new ForumService.NewTopic(b.title(), b.category(), b.kind(), b.pollOptions()));
        return ResponseEntity.status(201).header("ETag", ETags.of(t.version)).body(TopicResponse.of(t));
    }
    @PatchMapping("/api/v1/comms/forum/topics/{id}")
    public TopicResponse change(@PathVariable UUID id, @Valid @RequestBody TopicChangeRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return TopicResponse.of(forum.change(CallerHolder.require(), id, ETags.require(ifMatch), new ForumService.TopicChange(b.title(), b.category(), b.pinned(), b.status())));
    }
    @DeleteMapping("/api/v1/comms/forum/topics/{id}")
    public ResponseEntity<Void> removeTopic(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        forum.remove(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }
    @GetMapping("/api/v1/comms/forum/posts")
    public List<PostResponse> allPosts() { return forum.allPosts(CallerHolder.require()).stream().map(PostResponse::of).toList(); }
    @GetMapping("/api/v1/comms/forum/poll-results")
    public java.util.Map<UUID, Comms.PollResult> forumPolls() { return forum.pollResults(CallerHolder.require()); }
    @GetMapping("/api/v1/comms/forum/topics/{id}/posts")
    public List<PostResponse> posts(@PathVariable UUID id) { return forum.posts(CallerHolder.require(), id).stream().map(PostResponse::of).toList(); }
    @PostMapping("/api/v1/comms/forum/topics/{id}/posts")
    public ResponseEntity<PostResponse> reply(@PathVariable UUID id, @Valid @RequestBody PostRequest b) {
        return ResponseEntity.status(201).body(PostResponse.of(forum.reply(CallerHolder.require(), id, b.parentId(), b.body())));
    }
    @PostMapping("/api/v1/comms/forum/topics/{id}/vote")
    public Comms.PollResult voteTopic(@PathVariable UUID id, @Valid @RequestBody TopicVoteRequest b) { return forum.vote(CallerHolder.require(), id, b.choice()); }
    @GetMapping("/api/v1/comms/forum/topics/{id}/results")
    public Comms.PollResult topicResults(@PathVariable UUID id) { return forum.results(CallerHolder.require(), id); }
    @PatchMapping("/api/v1/comms/forum/posts/{id}")
    public PostResponse edit(@PathVariable UUID id, @Valid @RequestBody EditRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return PostResponse.of(forum.edit(CallerHolder.require(), id, ETags.require(ifMatch), b.body()));
    }
    @PostMapping("/api/v1/comms/forum/posts/{id}/hide")
    public PostResponse hide(@PathVariable UUID id, @Valid @RequestBody HideRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return PostResponse.of(forum.hide(CallerHolder.require(), id, ETags.require(ifMatch), b.hidden(), b.reason()));
    }
    @PostMapping("/api/v1/comms/forum/posts/{id}/react")
    public PostResponse react(@PathVariable UUID id) { return PostResponse.of(forum.react(CallerHolder.require(), id)); }
    @DeleteMapping("/api/v1/comms/forum/posts/{id}")
    public ResponseEntity<Void> deletePost(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        forum.delete(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }

    private static ResponseEntity<BroadcastResponse> tagged(Comms.Broadcast b) { return ResponseEntity.ok().header("ETag", ETags.of(b.version)).body(BroadcastResponse.of(b)); }
}
