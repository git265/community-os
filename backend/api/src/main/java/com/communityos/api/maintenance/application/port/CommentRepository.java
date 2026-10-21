package com.communityos.api.maintenance.application.port;

import com.communityos.api.maintenance.domain.Comment;
import java.util.List;
import java.util.UUID;

public interface CommentRepository {
    List<Comment> ofTicket(UUID ticketId, boolean includeInternal);
    /** The latest comments on the tickets this caller may see (one call for the whole discussion list). */
    List<Comment> recent(com.communityos.api.shared.access.Spec<com.communityos.api.maintenance.domain.Ticket> scope, boolean includeInternal, int limit);
    Comment insert(UUID ticketId, com.communityos.api.shared.domain.Ids.MembershipId author, String visibility, String body);
}
