package com.communityos.api.maintenance.domain;

import java.util.UUID;

/** A kind of task (Resident Maintenance, Purchase ...): who may raise it, how it is assigned, which approval stages it has. */
public record TaskType(UUID id, String name, String icon, String creatorScope, String assignmentMode, String quotationStage, String ecApprovalStage,
                       String treasurerStage, String invoiceStage, String paymentStage, boolean residentVisible, boolean residentDefault, boolean active) {
    public static final String RESIDENT = "Resident", STAFF = "EC / Staff", ANYONE = "Anyone";
    /** Internal tasks (raised by the EC / Facility Manager / MEP) are assigned to EC members or coordinators, never to field staff queues. */
    public boolean internal() { return STAFF.equals(creatorScope); }
    /** Role queue: field staff of the category pick it up (and a lone clocked-in member is assigned automatically). */
    public boolean queue() { return assignmentMode != null && assignmentMode.startsWith("Role queue"); }
}
