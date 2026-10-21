package com.communityos.api.maintenance.domain;

import com.communityos.api.shared.domain.Ids.MembershipId;
import java.time.Instant;
import java.util.UUID;

/** One post in a ticket's discussion. Public is seen by the resident; Internal only by the committee and staff. Comments are never edited. */
public record Comment(UUID id, String shortId, UUID ticketId, MembershipId author, String authorName, String visibility, String body, Instant createdAt) {
    public boolean internal() { return "Internal".equals(visibility); }
}
