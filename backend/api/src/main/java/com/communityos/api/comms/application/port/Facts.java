package com.communityos.api.comms.application.port;

import java.util.Optional;
import java.util.UUID;

/** The few words a notification needs about the thing it is about (an event carries ids, never names). */
public interface Facts {
    enum Kind { TICKET, BOOKING, GATE_APPROVAL, GATE_VISIT, GATE_FLAG }
    /** number: its short id; title: what it is called (ticket title, amenity, visitor); owner: who raised it; other: who is doing it; unitNo: the unit's number. */
    record Fact(String number, String title, java.util.UUID unitId, String unitNo, UUID owner, UUID other, String extra) {}
    Optional<Fact> of(Kind kind, UUID id);
}
