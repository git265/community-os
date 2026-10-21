package com.communityos.api.shared.time;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * The server's clock in the time zone of the community being served: "today", the start of a month, a bill's due date, quiet hours at the gate
 * and every journal date follow `platform.community.time_zone`, not the server's own zone. The instant is the base clock's (the system clock, or
 * the demo's ReplayClock). Without a caller (start-up, a job between communities) the zone is the configured default (`cos.web.time-zone`).
 *
 * Services use `LocalDate.now(clock)` / `clock.getZone()` and need nothing else. The zones are read once and kept for a few minutes, so a
 * changed zone shows within that time; an unknown zone name falls back to the default.
 */
public final class CommunityClock extends Clock {
    private record Cached(ZoneId zone, Instant until) {}
    static final Duration KEEP = Duration.ofMinutes(5);

    private final Clock base; private final Function<UUID, Optional<String>> zoneOf;
    private final Map<UUID, Cached> cache = new ConcurrentHashMap<>();
    public CommunityClock(Clock base, Function<UUID, Optional<String>> zoneOf) { this.base = base; this.zoneOf = zoneOf; }

    @Override public Instant instant() { return base.instant(); }
    @Override public long millis() { return base.millis(); }
    @Override public ZoneId getZone() {
        Caller c = CallerHolder.current().orElse(null);
        return c == null || c.community() == null ? base.getZone() : zoneFor(c.community().value());
    }
    /** A fixed zone: what java.time asks for when code wants a specific one. */
    @Override public Clock withZone(ZoneId zone) { return zone.equals(getZone()) ? this : new Fixed(this, zone); }

    /** The zone of one community (cached). */
    public ZoneId zoneFor(UUID community) {
        Instant now = Instant.now();
        Cached hit = cache.get(community);
        if (hit != null && hit.until().isAfter(now)) return hit.zone();
        ZoneId z = base.getZone();
        try { z = zoneOf.apply(community).map(ZoneId::of).orElse(base.getZone()); }
        catch (RuntimeException e) { /* an unknown zone name, or the lookup failed: the default */ }
        cache.put(community, new Cached(z, now.plus(KEEP)));
        return z;
    }
    /** After a community's zone was changed. */
    public void forget(UUID community) { cache.remove(community); }

    /** This clock's instant in a zone given by the caller. */
    private static final class Fixed extends Clock {
        private final Clock src; private final ZoneId zone;
        Fixed(Clock src, ZoneId zone) { this.src = src; this.zone = zone; }
        @Override public Instant instant() { return src.instant(); }
        @Override public ZoneId getZone() { return zone; }
        @Override public Clock withZone(ZoneId z) { return z.equals(zone) ? this : new Fixed(src, z); }
    }
}
