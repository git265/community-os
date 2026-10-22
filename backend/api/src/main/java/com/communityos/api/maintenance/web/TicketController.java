package com.communityos.api.maintenance.web;

import com.communityos.api.maintenance.application.FieldStaffService;
import com.communityos.api.maintenance.application.TicketService;
import com.communityos.api.maintenance.application.port.TicketRepository;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.maintenance.domain.TicketStatus;
import com.communityos.api.maintenance.web.TicketDtos.AssignRequest;
import com.communityos.api.maintenance.web.TicketDtos.CandidateResponse;
import com.communityos.api.maintenance.web.TicketDtos.ClockRequest;
import com.communityos.api.maintenance.web.TicketDtos.CommentRequest;
import com.communityos.api.maintenance.web.TicketDtos.CommentResponse;
import com.communityos.api.maintenance.web.TicketDtos.EditRequest;
import com.communityos.api.maintenance.web.TicketDtos.FieldStaffRequest;
import com.communityos.api.maintenance.web.TicketDtos.FieldStaffResponse;
import com.communityos.api.maintenance.web.TicketDtos.MeTooRequest;
import com.communityos.api.maintenance.web.TicketDtos.RaiseRequest;
import com.communityos.api.maintenance.web.TicketDtos.RatingRequest;
import com.communityos.api.maintenance.web.TicketDtos.StatusRequest;
import com.communityos.api.maintenance.web.TicketDtos.TaskTypeResponse;
import com.communityos.api.maintenance.web.TicketDtos.TicketResponse;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.communityos.api.shared.web.PageQuery;
import com.communityos.api.shared.web.PageResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Tag(name = "Maintenance")
public class TicketController {
    private final TicketService tickets; private final FieldStaffService staff;
    public TicketController(TicketService tickets, FieldStaffService staff) {
        this.tickets = tickets; this.staff = staff;
    }

    @GetMapping("/api/v1/tickets")
    public PageResponse<TicketResponse> list(@RequestParam(required = false) String status, @RequestParam(defaultValue = "false") boolean active,
                                             @RequestParam(required = false) String category, @RequestParam(required = false) UUID unit,
                                             @RequestParam(defaultValue = "false") boolean mine, @RequestParam(defaultValue = "false") boolean assignedToMe,
                                             @RequestParam(required = false) String q, @RequestParam(required = false) Integer limit, @RequestParam(required = false) Integer offset,
                                             @RequestParam(required = false) List<String> statusIn, @RequestParam(required = false) List<String> priority,
                                             @RequestParam(required = false) String taskType, @RequestParam(required = false) Boolean financial,
                                             @RequestParam(required = false) String scope, @RequestParam(required = false) String order) {
        Caller c = CallerHolder.require();
        TicketRepository.Filter f = new TicketRepository.Filter(status, active, category, unit == null ? null : new UnitId(unit), mine ? c.membership() : null,
            assignedToMe ? c.membership() : null, q, statusIn, priority, taskType, financial, scope, order);
        return PageResponse.of(tickets.list(c, f, PageQuery.of(limit, offset)).map(TicketResponse::of));
    }
    @GetMapping("/api/v1/tickets/{id}")
    public ResponseEntity<TicketResponse> get(@PathVariable UUID id) { return tagged(tickets.get(CallerHolder.require(), id), 200); }

    @PostMapping("/api/v1/tickets")
    public ResponseEntity<TicketResponse> raise(@Valid @RequestBody RaiseRequest b) {
        Caller c = CallerHolder.require();
        TicketResponse r = TicketResponse.of(tickets.raise(c,
            new TicketService.RaiseTicket(b.taskTypeId(), b.title(), b.description(), b.unitId() == null ? null : new UnitId(b.unitId()), b.scope(), b.location(), b.category(),
                b.subCategory(), b.priority(), b.preferredTime(), b.slaDueAt())));
        return ResponseEntity.status(201).header("ETag", ETags.of(r.version())).body(r);
    }
    @PatchMapping("/api/v1/tickets/{id}")
    public ResponseEntity<TicketResponse> edit(@PathVariable UUID id, @Valid @RequestBody EditRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(tickets.edit(CallerHolder.require(), id, ETags.require(ifMatch), new Ticket.Changes(b.title(), b.description(), b.category(), b.subCategory(), b.priority(),
            b.location(), b.preferredTime(), b.slaDueAt(), b.awaitingParts(), b.materialsCost(), b.financial(), b.workDone())), 200);
    }
    @PostMapping("/api/v1/tickets/{id}/assign")
    public ResponseEntity<TicketResponse> assign(@PathVariable UUID id, @RequestBody AssignRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(tickets.assign(CallerHolder.require(), id, ETags.require(ifMatch), b.assigneeId() == null ? null : new MembershipId(b.assigneeId())), 200);
    }
    @PostMapping("/api/v1/tickets/{id}/status")
    public ResponseEntity<TicketResponse> status(@PathVariable UUID id, @Valid @RequestBody StatusRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(tickets.changeStatus(CallerHolder.require(), id, ETags.require(ifMatch), TicketStatus.of(b.status()), b.reason()), 200);
    }
    @PostMapping("/api/v1/tickets/{id}/me-too")
    public ResponseEntity<TicketResponse> meToo(@PathVariable UUID id, @RequestBody(required = false) MeTooRequest b) {
        return tagged(tickets.meToo(CallerHolder.require(), id, b == null || b.unitId() == null ? null : new UnitId(b.unitId()), true), 200);
    }
    @DeleteMapping("/api/v1/tickets/{id}/me-too")
    public ResponseEntity<TicketResponse> leave(@PathVariable UUID id, @RequestParam(required = false) UUID unit) {
        return tagged(tickets.meToo(CallerHolder.require(), id, unit == null ? null : new UnitId(unit), false), 200);
    }
    @PostMapping("/api/v1/tickets/{id}/rating")
    public ResponseEntity<TicketResponse> rate(@PathVariable UUID id, @Valid @RequestBody RatingRequest b) { return tagged(tickets.rate(CallerHolder.require(), id, b.rating()), 200); }

    @GetMapping("/api/v1/tickets/{id}/assignees")
    public List<CandidateResponse> assignees(@PathVariable UUID id) { return tickets.assignees(CallerHolder.require(), id).stream().map(CandidateResponse::of).toList(); }
    @GetMapping("/api/v1/tickets/{id}/comments")
    public List<CommentResponse> comments(@PathVariable UUID id) { return tickets.comments(CallerHolder.require(), id).stream().map(CommentResponse::of).toList(); }
    @PostMapping("/api/v1/tickets/{id}/comments")
    public ResponseEntity<CommentResponse> comment(@PathVariable UUID id, @Valid @RequestBody CommentRequest b) {
        return ResponseEntity.status(201).body(CommentResponse.of(tickets.comment(CallerHolder.require(), id, b.body(), b.visibility())));
    }

    @GetMapping("/api/v1/ticket-comments")
    public List<CommentResponse> recentComments(@RequestParam(required = false) Integer limit) {
        return tickets.recentComments(CallerHolder.require(), limit == null ? 500 : limit).stream().map(CommentResponse::of).toList();
    }

    @GetMapping("/api/v1/task-types")
    public List<TaskTypeResponse> taskTypes() { Caller c = CallerHolder.require(); return tickets.taskTypes(c).stream().map((t) -> TaskTypeResponse.of(t, c)).toList(); }

    @GetMapping("/api/v1/field-staff")
    public List<FieldStaffResponse> fieldStaff() { return staff.list(CallerHolder.require()).stream().map(FieldStaffResponse::of).toList(); }
    @PostMapping("/api/v1/field-staff")
    public ResponseEntity<FieldStaffResponse> addFieldStaff(@Valid @RequestBody FieldStaffRequest b) {
        return ResponseEntity.status(201).body(FieldStaffResponse.of(staff.add(CallerHolder.require(), new MembershipId(b.membershipId()), b.trade(), b.shift(), b.phone())));
    }
    @PatchMapping("/api/v1/field-staff/{id}")
    public FieldStaffResponse clock(@PathVariable UUID id, @Valid @RequestBody ClockRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return FieldStaffResponse.of(staff.clock(CallerHolder.require(), id, b.clockedIn(), ETags.require(ifMatch)));
    }

    private static ResponseEntity<TicketResponse> tagged(Ticket t, int status) { return ResponseEntity.status(status).header("ETag", ETags.of(t.version())).body(TicketResponse.of(t)); }
}
