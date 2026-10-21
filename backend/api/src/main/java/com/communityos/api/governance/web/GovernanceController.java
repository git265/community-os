package com.communityos.api.governance.web;

import com.communityos.api.governance.application.BallotService;
import com.communityos.api.governance.application.MeetingService;
import com.communityos.api.governance.application.VoteService;
import com.communityos.api.governance.domain.Governance;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Meetings and e-voting. Who scheduled, published, opened or closed, the roll's fingerprint, the count and the chain are the server's. */
@RestController
@Tag(name = "Governance")
public class GovernanceController {
    public record MeetingRequest(@NotNull @Size(max = 200) String title, @NotNull @Size(max = 80) String committee, @NotNull LocalDate date, @NotNull LocalTime startTime, LocalTime endTime,
                                 @Size(max = 300) String location, @Pattern(regexp = "Scheduled|Completed|Cancelled") String status,
                                 @Pattern(regexp = "Internal \\(committee only\\)|Published to residents") String visibility, @Size(max = 100000) String agenda,
                                 @Size(max = 100000) String minutes, @Size(max = 500) String cancelReason) {
        MeetingService.Fields fields() { return new MeetingService.Fields(title, committee, date, startTime, endTime, location, status, visibility, agenda, minutes, cancelReason); }
    }
    public record MeetingResponse(UUID id, String shortId, String title, String committee, LocalDate date, LocalTime startTime, LocalTime endTime, String location, String status,
                                  String visibility, Instant publishedAt, String agenda, String minutes, Instant minutesAt, String cancelReason, Instant createdAt, Instant updatedAt, long version) {
        static MeetingResponse of(Governance.Meeting m) {
            return new MeetingResponse(m.id, m.shortId, m.title, m.committee, m.date, m.startTime, m.endTime, m.location, m.status, m.visibility, m.publishedAt, m.agenda, m.minutes, m.minutesAt,
                m.cancelReason, m.createdAt, m.updatedAt, m.version);
        }
    }

    public record BallotRequest(@NotNull @Size(max = 200) String title, @Size(max = 20000) String description, @Pattern(regexp = "Resolution|Choose one") String kind,
                                @Size(max = 10) List<String> options, @NotNull LocalDate opensOn, @NotNull LocalDate closesOn,
                                @Min(0) @Max(100) BigDecimal quorumPct, @Min(0) @Max(100) BigDecimal passPct, UUID meetingId) {
        BallotService.Fields fields() { return new BallotService.Fields(title, description, kind, options, opensOn, closesOn, quorumPct, passPct, meetingId); }
    }
    public record CodeRequest(UUID unitId) {}
    public record VerifyRequest(UUID unitId, @NotNull @Pattern(regexp = "\\s*[0-9]{6}\\s*") String code) {}
    public record CastRequest(UUID unitId, @NotNull @Size(max = 200) String proof, @NotNull @Size(max = 80) String choice) {}
    public record ProofResponse(String proof) {}
    public record Results(Map<String, Integer> counts, int cast, int rollSize, boolean quorumMet, String outcome, BigDecimal turnoutPct) {}
    public record BallotResponse(UUID id, String shortId, String title, String description, String kind, List<String> options, LocalDate opensOn, LocalDate closesOn, BigDecimal quorumPct,
                                 BigDecimal passPct, String status, String rollHash, int rollSize, int votesCast, Instant openedAt, Instant closedAt, String chainHead, Integer votesCounted,
                                 UUID meetingId, List<BallotService.MyUnit> myUnits, String whyNotMe, Results results, Governance.Chain chain, Instant createdAt, long version) {
        static BallotResponse of(BallotService.View v) {
            Governance.Ballot b = v.ballot();
            Governance.Tally t = v.tally();
            return new BallotResponse(b.id, b.shortId, b.title, b.description, b.kind, b.options, b.opensOn, b.closesOn, b.quorumPct, b.passPct, b.status, b.rollHash, b.rollSize, b.votesCast,
                b.openedAt, b.closedAt, b.closed() ? b.chainHead : null, b.votesCounted, b.meetingId, v.mine(), v.whyNotMe(),
                t == null ? null : new Results(t.counts(), t.cast(), t.rollSize(), t.quorumMet(), t.outcome(), t.turnoutPct()), v.chain(), b.createdAt, b.version);
        }
        static BallotResponse draft(Governance.Ballot b) { return of(new BallotService.View(b, List.of(), b.draft() ? "Voting has not opened yet" : "", null, null)); }
    }

    private final MeetingService meetings; private final BallotService ballots; private final VoteService votes;
    public GovernanceController(MeetingService meetings, BallotService ballots, VoteService votes) { this.meetings = meetings; this.ballots = ballots; this.votes = votes; }

    // ---- meetings --------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/governance/meetings")
    public List<MeetingResponse> meetings(@RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to, @RequestParam(required = false) String committee) {
        return meetings.list(CallerHolder.require(), from, to, committee).stream().map(MeetingResponse::of).toList();
    }
    @GetMapping("/api/v1/governance/meetings/{id}")
    public ResponseEntity<MeetingResponse> meeting(@PathVariable UUID id) { return tagged(meetings.get(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/governance/meetings")
    public ResponseEntity<MeetingResponse> schedule(@Valid @RequestBody MeetingRequest b) {
        Governance.Meeting m = meetings.create(CallerHolder.require(), b.fields());
        return ResponseEntity.status(201).header("ETag", ETags.of(m.version)).body(MeetingResponse.of(m));
    }
    @PutMapping("/api/v1/governance/meetings/{id}")
    public ResponseEntity<MeetingResponse> change(@PathVariable UUID id, @Valid @RequestBody MeetingRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(meetings.update(CallerHolder.require(), id, ETags.require(ifMatch), b.fields()));
    }
    @DeleteMapping("/api/v1/governance/meetings/{id}")
    public ResponseEntity<Void> drop(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        meetings.delete(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }

    // ---- ballots ---------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/governance/ballots")
    public List<BallotResponse> ballots() { return ballots.list(CallerHolder.require()).stream().map(BallotResponse::of).toList(); }
    @GetMapping("/api/v1/governance/ballots/{id}")
    public ResponseEntity<BallotResponse> ballot(@PathVariable UUID id) { return tagged(ballots.get(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/governance/ballots")
    public ResponseEntity<BallotResponse> draft(@Valid @RequestBody BallotRequest b) {
        Governance.Ballot x = ballots.create(CallerHolder.require(), b.fields());
        return ResponseEntity.status(201).header("ETag", ETags.of(x.version)).body(BallotResponse.draft(x));
    }
    @PutMapping("/api/v1/governance/ballots/{id}")
    public ResponseEntity<BallotResponse> edit(@PathVariable UUID id, @Valid @RequestBody BallotRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        Governance.Ballot x = ballots.update(CallerHolder.require(), id, ETags.require(ifMatch), b.fields());
        return ResponseEntity.ok().header("ETag", ETags.of(x.version)).body(BallotResponse.draft(x));
    }
    @DeleteMapping("/api/v1/governance/ballots/{id}")
    public ResponseEntity<Void> discard(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        ballots.delete(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }
    @PostMapping("/api/v1/governance/ballots/{id}/open")
    public ResponseEntity<BallotResponse> open(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(ballots.open(CallerHolder.require(), id, ETags.require(ifMatch)));
    }
    @PostMapping("/api/v1/governance/ballots/{id}/close")
    public ResponseEntity<BallotResponse> close(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(ballots.close(CallerHolder.require(), id, ETags.require(ifMatch)));
    }
    @GetMapping("/api/v1/governance/ballots/{id}/roll")
    public List<BallotService.RollEntry> roll(@PathVariable UUID id) { return ballots.roll(CallerHolder.require(), id); }
    @GetMapping("/api/v1/governance/ballots/{id}/box")
    public BallotService.Box box(@PathVariable UUID id) { return ballots.box(CallerHolder.require(), id); }

    // ---- voting ----------------------------------------------------------------------------------------------------------------------------------
    @PostMapping("/api/v1/governance/ballots/{id}/code")
    public VoteService.Sent code(@PathVariable UUID id, @Valid @RequestBody CodeRequest b) { return votes.requestCode(CallerHolder.require(), id, b.unitId()); }
    @PostMapping("/api/v1/governance/ballots/{id}/code/verify")
    public ProofResponse verify(@PathVariable UUID id, @Valid @RequestBody VerifyRequest b) { return new ProofResponse(votes.verifyCode(CallerHolder.require(), id, b.unitId(), b.code())); }
    @PostMapping("/api/v1/governance/ballots/{id}/votes")
    public ResponseEntity<VoteService.Receipt> cast(@PathVariable UUID id, @Valid @RequestBody CastRequest b) {
        Caller c = CallerHolder.require();
        return ResponseEntity.status(201).body(votes.cast(c, id, b.unitId(), b.proof(), b.choice()));
    }

    private static ResponseEntity<MeetingResponse> tagged(Governance.Meeting m) { return ResponseEntity.ok().header("ETag", ETags.of(m.version)).body(MeetingResponse.of(m)); }
    private static ResponseEntity<BallotResponse> tagged(BallotService.View v) { return ResponseEntity.ok().header("ETag", ETags.of(v.ballot().version)).body(BallotResponse.of(v)); }
}
