package com.communityos.service.audit;

import java.time.Clock;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

/** Times as the web app writes them: 2026-10-19T12:00:00.000Z (always milliseconds), so stamps sort and compare as text. */
public final class Stamps {
    private Stamps() {}
    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    public static String iso(Clock clock) { return ISO.format(clock.instant()); }
}
