package com.communityos.api.maintenance.web;

import com.communityos.api.maintenance.application.TicketRules;
import com.communityos.api.maintenance.application.port.FieldStaffRepository.FieldStaff;
import com.communityos.api.maintenance.application.port.MaintenanceDirectory.Candidate;
import com.communityos.api.maintenance.domain.Comment;
import com.communityos.api.maintenance.domain.TaskType;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.security.Caller;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Ticket bodies. A request carries only what the caller may type: no status, number, raiser, assignee, times or rating on a new ticket (those
 * have their own commands), and nothing of the financial workflow (quotations, invoices, approvals come with the next maintenance step).
 */
public final class TicketDtos {
    private TicketDtos() {}

    public record RaiseRequest(UUID taskTypeId, @NotBlank @Size(min = 3, max = 200) String title, @Size(max = 10000) String description, UUID unitId,
                               @Size(max = 20) String scope, @Size(max = 200) String location, @NotBlank @Size(max = 40) String category, @Size(max = 80) String subCategory,
                               @Size(max = 20) String priority, @Size(max = 120) String preferredTime, LocalDate slaDueAt) {}
    public record EditRequest(@Size(min = 3, max = 200) String title, @Size(max = 10000) String description, @Size(max = 40) String category, @Size(max = 80) String subCategory,
                              @Size(max = 20) String priority, @Size(max = 200) String location, @Size(max = 120) String preferredTime, LocalDate slaDueAt, Boolean awaitingParts,
                              Money materialsCost, Boolean financial, LocalDate workDone) {}
    public record AssignRequest(UUID assigneeId) {}
    public record StatusRequest(@NotBlank @Size(max = 20) String status, @Size(max = 500) String reason) {}
    public record MeTooRequest(UUID unitId) {}
    public record RatingRequest(@NotNull @Min(1) @Max(5) Integer rating) {}
    public record CommentRequest(@NotBlank @Size(max = 5000) String body, @Size(max = 10) String visibility) {}
    public record FieldStaffRequest(@NotNull UUID membershipId, @NotBlank @Size(max = 40) String trade, @Size(max = 20) String shift, @Size(max = 20) String phone) {}
    public record ClockRequest(@NotNull Boolean clockedIn) {}

    public record TicketResponse(UUID id, String shortId, UUID taskTypeId, String taskType, String title, String description, UUID unitId, String unitNo, String scope,
                                 String location, String category, String subCategory, String priority, String status, UUID assigneeId, String assigneeName, LocalDate slaDueAt,
                                 String preferredTime, List<UUID> affectedUnitIds, Integer residentRating, UUID raisedById, String raisedByName, String raisedByRole,
                                 boolean awaitingParts, Money materialsCost, boolean financial, LocalDate workDone, Instant assignedAt, Instant startedAt, Instant completedAt,
                                 Instant closedAt, Instant cancelledAt, String cancelReason, int reopenCount, Instant createdAt, Instant updatedAt, long version) {
        static TicketResponse of(Ticket t) {
            Ticket.State s = t.state();
            return new TicketResponse(s.id, s.shortId, s.taskType == null ? null : s.taskType.id(), s.taskType == null ? null : s.taskType.name(), s.title, s.description,
                s.unit == null ? null : s.unit.value(), s.unitNo, s.scope, s.location, s.category, s.subCategory, s.priority, s.status.label(),
                s.assignee == null ? null : s.assignee.value(), s.assigneeName, s.slaDueAt, s.preferredTime, s.affectedUnits.stream().map((u) -> u.value()).toList(),
                s.residentRating, s.raisedBy.value(), s.raisedByName, s.raisedByRole, s.awaitingParts, s.materialsCost, s.financial, s.workDone, s.assignedAt, s.startedAt,
                s.completedAt, s.closedAt, s.cancelledAt, s.cancelReason, s.reopenCount, s.createdAt, s.updatedAt, t.version());
        }
    }
    public record TaskTypeResponse(UUID id, String name, String icon, String creatorScope, String assignmentMode, String quotationStage, String ecApprovalStage,
                                   String treasurerStage, String invoiceStage, String paymentStage, boolean residentVisible, boolean residentDefault, boolean canRaise) {
        static TaskTypeResponse of(TaskType t, Caller c) {
            return new TaskTypeResponse(t.id(), t.name(), t.icon(), t.creatorScope(), t.assignmentMode(), t.quotationStage(), t.ecApprovalStage(), t.treasurerStage(),
                t.invoiceStage(), t.paymentStage(), t.residentVisible(), t.residentDefault(), TicketRules.mayRaise(c, t));
        }
    }
    public record CommentResponse(UUID id, String shortId, UUID ticketId, UUID authorId, String authorName, String visibility, String body, Instant createdAt) {
        static CommentResponse of(Comment c) { return new CommentResponse(c.id(), c.shortId(), c.ticketId(), c.author().value(), c.authorName(), c.visibility(), c.body(), c.createdAt()); }
    }
    public record CandidateResponse(UUID membershipId, String name, String kind, boolean clockedIn, String trade) {
        static CandidateResponse of(Candidate c) { return new CandidateResponse(c.id().value(), c.name(), c.kind(), c.clockedIn(), c.trade()); }
    }
    public record FieldStaffResponse(UUID id, String shortId, UUID membershipId, String name, String trade, String shift, String phone, boolean clockedIn, long version) {
        static FieldStaffResponse of(FieldStaff f) {
            return new FieldStaffResponse(f.id(), f.shortId(), f.membership() == null ? null : f.membership().value(), f.name(), f.trade(), f.shift(), f.phone(), f.clockedIn(), f.version());
        }
    }
}
