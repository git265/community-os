package com.communityos.api.demo;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.function.Supplier;

/**
 * The server's clock, which the demo loader can set back - for its own thread only - so that each sample record is made through the services at the
 * time it happened (a booking made the week before its date, a bill paid on its day). Every other thread, and every request, sees the real time.
 * It is the clock only when cos.demo.enabled (CoreConfig); production runs on the plain system clock.
 */
public final class ReplayClock extends Clock {
    private static final ThreadLocal<Instant> AT = new ThreadLocal<>();
    private final Clock base;
    public ReplayClock(Clock base) { this.base = base; }

    /** Run work as if it were `at` (on this thread). */
    public static <T> T at(Instant at, Supplier<T> work) {
        Instant before = AT.get();
        AT.set(at);
        try { return work.get(); } finally { if (before == null) AT.remove(); else AT.set(before); }
    }
    public static boolean replaying() { return AT.get() != null; }

    @Override public Instant instant() { Instant at = AT.get(); return at != null ? at : base.instant(); }
    @Override public ZoneId getZone() { return base.getZone(); }
    @Override public Clock withZone(ZoneId zone) { return new ReplayClock(base.withZone(zone)); }
}
