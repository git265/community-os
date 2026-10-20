package com.communityos.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalInt;

/** Sign-in state in memory (profile `memory`, tests). One server only: a restart signs everybody out. */
public class InMemoryAuthStore implements AuthStore {
    private final Clock clock;
    private final List<Object[]> attempts = new ArrayList<>();   // {key, Instant}
    private final List<Object[]> codes = new ArrayList<>();      // {id, tenant, phone, salt, hash, tries, expiresAt, usedAt, createdAt}
    private final Map<String, Session> sessions = new LinkedHashMap<>();
    private final Map<String, List<String>> used = new LinkedHashMap<>();
    private long seq;

    public InMemoryAuthStore(Clock clock) { this.clock = clock; }

    private Instant now() { return clock.instant(); }

    @Override public synchronized int attempts(String key, long seconds) {
        Instant from = now().minusSeconds(seconds); int n = 0;
        for (Object[] a : attempts) if (a[0].equals(key) && ((Instant) a[1]).isAfter(from)) n++;
        return n;
    }
    @Override public synchronized void note(String key) { attempts.add(new Object[] {key, now()}); }

    private Code code(Object[] c) { return new Code((long) c[0], (String) c[3], (String) c[4], (int) c[5], (Instant) c[6], (Instant) c[8]); }
    @Override public synchronized Optional<Code> latestCode(String tenant, String phone) {
        for (int i = codes.size() - 1; i >= 0; i--) { Object[] c = codes.get(i); if (c[1].equals(tenant) && c[2].equals(phone) && c[7] == null) return Optional.of(code(c)); }
        return Optional.empty();
    }
    @Override public synchronized Optional<Instant> lastCodeAt(String tenant, String phone) {
        for (int i = codes.size() - 1; i >= 0; i--) { Object[] c = codes.get(i); if (c[1].equals(tenant) && c[2].equals(phone)) return Optional.of((Instant) c[8]); }
        return Optional.empty();
    }
    @Override public synchronized void retireCodes(String tenant, String phone) { for (Object[] c : codes) if (c[1].equals(tenant) && c[2].equals(phone) && c[7] == null) c[7] = now(); }
    @Override public synchronized void addCode(String tenant, String phone, String salt, String hash, Instant expiresAt) { codes.add(new Object[] {++seq, tenant, phone, salt, hash, 0, expiresAt, null, now()}); }
    @Override public synchronized void useCode(long id) { for (Object[] c : codes) if ((long) c[0] == id && c[7] == null) c[7] = now(); }
    @Override public synchronized OptionalInt bumpTries(long id, int max) {
        for (Object[] c : codes) if ((long) c[0] == id) { int t = (int) c[5]; if (t >= max) return OptionalInt.empty(); c[5] = t + 1; return OptionalInt.of(t + 1); }
        return OptionalInt.empty();
    }

    @Override public synchronized void addSession(Session s, String ip) { sessions.put(s.id(), s); used.put(s.id(), new ArrayList<>()); }
    @Override public synchronized Optional<Session> sessionByRefresh(String hash) {
        for (Session s : sessions.values()) if (s.refreshHash().equals(hash) || used.get(s.id()).contains(hash)) return Optional.of(s);
        return Optional.empty();
    }
    @Override public synchronized Optional<Session> session(String id) { return Optional.ofNullable(id == null ? null : sessions.get(id)); }
    @Override public synchronized void revoke(String id) { Session s = sessions.get(id); if (s != null && s.revokedAt() == null) sessions.put(id, with(s, s.roleId(), s.refreshHash(), s.profile(), now())); }
    @Override public synchronized void rotate(String id, String next) {
        Session s = sessions.get(id); if (s == null) return;
        List<String> u = used.get(id); u.add(s.refreshHash()); while (u.size() > 100) u.remove(0);
        sessions.put(id, with(s, s.roleId(), next, s.profile(), s.revokedAt()));
    }
    @Override public synchronized void switchRole(String id, String roleId, String unit) {
        Session s = sessions.get(id); if (s == null) return;
        ObjectNode p = s.profile() != null && s.profile().isObject() ? ((ObjectNode) s.profile()).deepCopy() : JsonNodeFactory.instance.objectNode();
        if (unit != null) p.put("unit", unit);
        sessions.put(id, with(s, roleId, s.refreshHash(), p, s.revokedAt()));
    }
    @Override public synchronized void revokeByRefresh(String hash) { sessionByRefresh(hash).ifPresent(s -> revoke(s.id())); }

    private static Session with(Session s, String roleId, String refresh, JsonNode profile, Instant revokedAt) {
        return new Session(s.id(), s.tenant(), s.userId(), roleId, refresh, s.demo(), profile, s.expiresAt(), revokedAt);
    }
}
