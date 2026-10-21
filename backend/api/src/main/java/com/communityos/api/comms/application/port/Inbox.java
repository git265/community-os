package com.communityos.api.comms.application.port;

import com.communityos.api.comms.domain.Comms;
import java.util.List;
import java.util.UUID;

/** The inbox: fan a message out to one row per person (and queue their extra channels), and read / mark one's own rows. */
public interface Inbox {
    /** Returns how many people got it. The person causing it (the current actor) is never told about their own action. */
    int deliver(Comms.Message m);
    /** Rows addressed to this member, newest first. */
    List<Comms.Note> mine(UUID membership, boolean unreadOnly, int limit);
    int unread(UUID membership);
    /** Mark one (null: all) of this member's rows read; returns how many changed. */
    int markRead(UUID membership, UUID id);
}
