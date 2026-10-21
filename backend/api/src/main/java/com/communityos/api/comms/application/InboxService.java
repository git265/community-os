package com.communityos.api.comms.application;

import com.communityos.api.comms.application.port.Inbox;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import java.util.List;
import java.util.UUID;

/** A person's own inbox: read it, count what is unread, mark one or all read. Nobody reads or changes another person's rows. */
public final class InboxService {
    private final Inbox inbox;
    public InboxService(Inbox inbox) { this.inbox = inbox; }

    public List<Comms.Note> mine(Caller c, boolean unreadOnly, int limit) { return inbox.mine(me(c), unreadOnly, limit); }
    public int unread(Caller c) { return inbox.unread(me(c)); }
    public int markRead(Caller c, UUID id) { return inbox.markRead(me(c), id); }
    public int markAllRead(Caller c) { return inbox.markRead(me(c), null); }

    static UUID me(Caller c) {
        if (c.membership() == null) throw new AccessDenied("Only a member of the community has an inbox");
        return c.membership().value();
    }
}
