package com.communityos.api.comms.adapter;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * Live notifications to the open app (server push over one long-lived HTTP response per tab, Server-Sent Events). Each server instance keeps
 * the connections it holds; every couple of seconds it asks the database once for the new notifications of the members connected to it (not
 * one query per tab) and pushes each to that member's tabs. Several instances need nothing shared: each finds its own members' rows.
 *
 * A notification is visible once its transaction commits, which can be a moment after the time it was stamped: the look-back window covers
 * that, and ids already sent are remembered for a while so nothing is pushed twice.
 */
public final class LiveHub {
    /** One open tab. `send` returns false when the tab has gone (its connection is then dropped). */
    public interface Tab { boolean send(String event, Map<String, Object> data); }
    record Conn(UUID community, Tab tab, Instant from) {}   // from: what the tab had loaded already is not pushed again (a little overlap; the app drops ids it has)
    static final String NEW = """
        SELECT n.community_id, n.id, n.to_membership_id, n.created_at, n.event, n.kind, n.title, n.body, n.link, n.ref_id
        FROM comms.notification n
        WHERE n.to_membership_id IN (:members) AND n.created_at > CAST(:since AS timestamptz)
        ORDER BY n.created_at LIMIT 500""";
    static final Duration LOOK_BACK = Duration.ofSeconds(15);

    private final NamedParameterJdbcTemplate platform; private final java.time.Clock clock;
    private final Map<UUID, List<Conn>> byMember = new ConcurrentHashMap<>();
    private final Map<UUID, Instant> sent = new ConcurrentHashMap<>();     // notification id -> when it was pushed (kept for the look-back window)
    private volatile Instant since;
    public LiveHub(NamedParameterJdbcTemplate platform, java.time.Clock clock) { this.platform = platform; this.clock = clock; this.since = clock.instant(); }

    public void connect(UUID community, UUID member, Tab tab) {
        Conn c = new Conn(community, tab, clock.instant().minusSeconds(5));
        byMember.computeIfAbsent(member, (k) -> new CopyOnWriteArrayList<>()).add(c);
        synchronized (this) { if (c.from().isBefore(since)) since = c.from(); }
    }
    public void disconnect(UUID member, Tab tab) {
        List<Conn> l = byMember.get(member);
        if (l != null) { l.removeIf((c) -> c.tab() == tab); if (l.isEmpty()) byMember.remove(member, l); }
    }
    public int connections() { return byMember.values().stream().mapToInt(List::size).sum(); }

    /** One round: the new notifications of everyone connected here, each pushed to their tabs. Returns how many were pushed. */
    public int fanOut() {
        Instant now = clock.instant();
        sent.entrySet().removeIf((e) -> e.getValue().isBefore(now.minus(LOOK_BACK.multipliedBy(2))));
        if (byMember.isEmpty()) { since = now.minus(LOOK_BACK); return 0; }
        Set<UUID> members = Set.copyOf(byMember.keySet());
        Instant from = since;
        List<Map<String, Object>> rows = platform.query(NEW, Map.of("members", List.copyOf(members), "since", java.sql.Timestamp.from(from)), (rs, i) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("_community", rs.getObject("community_id", UUID.class)); m.put("_member", rs.getObject("to_membership_id", UUID.class));
            m.put("id", rs.getObject("id", UUID.class).toString()); m.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
            m.put("event", rs.getString("event")); m.put("kind", rs.getString("kind")); m.put("title", rs.getString("title")); m.put("body", rs.getString("body"));
            m.put("link", rs.getString("link")); Object ref = rs.getObject("ref_id", UUID.class); m.put("refId", ref == null ? null : ref.toString());
            return m;
        });
        int n = 0;
        for (Map<String, Object> r : rows) {
            UUID id = UUID.fromString((String) r.get("id"));
            if (sent.putIfAbsent(id, now) != null) continue;
            UUID community = (UUID) r.remove("_community"), member = (UUID) r.remove("_member");
            Instant at = Instant.parse((String) r.get("createdAt"));
            List<Conn> tabs = byMember.getOrDefault(member, List.of());
            for (Conn c : new ArrayList<>(tabs)) {
                if (!c.community().equals(community) || at.isBefore(c.from())) continue;                       // the same person signed in to another community in that tab
                if (c.tab().send("notification", r)) n++; else disconnect(member, c.tab());
            }
        }
        since = now.minus(LOOK_BACK);
        return n;
    }
    /** A comment line now and then keeps proxies from closing an idle stream; a tab that has gone is dropped. */
    public void heartbeat() {
        for (Map.Entry<UUID, List<Conn>> e : byMember.entrySet()) for (Conn c : new ArrayList<>(e.getValue())) if (!c.tab().send("ping", Map.of())) disconnect(e.getKey(), c.tab());
    }
}
