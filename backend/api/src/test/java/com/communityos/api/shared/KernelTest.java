package com.communityos.api.shared;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.custom.CustomFields;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.EventPublisher;
import com.communityos.api.shared.events.OutboxMessage;
import com.communityos.api.shared.events.OutboxRelay;
import com.communityos.api.shared.resilience.CircuitBreaker;
import com.communityos.api.shared.resilience.Resilient;
import com.communityos.api.shared.resilience.RetryPolicy;
import com.communityos.api.shared.resilience.TransientFailure;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.web.Idempotency;
import com.communityos.api.shared.web.Json;
import com.communityos.api.Fixtures;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class KernelTest {
    record Row(String unit, String block) {}
    record Req(String unitId, Money amount) {}
    record Body(String a) {}
    record Out(String id) {}

    @Test void specCombinesSqlAndPredicateWithDistinctParameterNames() {
        Spec<Row> a = Spec.eq("u.id", "A", (r) -> r.unit().equals("A"));
        Spec<Row> b = Spec.eq("u.id", "B", (r) -> r.unit().equals("B"));
        Spec<Row> s = a.or(b).and(Spec.in("u.block_id", List.of("1"), (r) -> r.block().equals("1")));
        assertEquals("((u.id = :s_u_id OR u.id = :s_u_id_2) AND u.block_id IN (:s_u_block_id))", s.sql());
        assertEquals("A", s.params().get("s_u_id")); assertEquals("B", s.params().get("s_u_id_2"));
        assertTrue(s.matches(new Row("B", "1"))); assertFalse(s.matches(new Row("B", "2"))); assertFalse(s.matches(new Row("C", "1")));
        assertEquals("FALSE", Spec.<Row>in("u.id", List.of(), (r) -> true).sql(), "empty IN matches nothing");
        assertEquals(s.sql(), a.or(b).and(Spec.in("u.block_id", List.of("1"), (r) -> true)).sql(), "same rule, same SQL text (statement cache)");
    }

    @Test void retryRetriesOnlyTransientFailuresWithBackoff() {
        List<Duration> slept = new ArrayList<>();
        Resilient r = new Resilient(Duration.ZERO, new CircuitBreaker("t", 100, Duration.ofSeconds(1), Clock.systemUTC()), RetryPolicy.transientFailures(3), slept::add);
        AtomicInteger calls = new AtomicInteger();
        assertEquals("ok", r.call(() -> { if (calls.incrementAndGet() < 3) throw new TransientFailure("503"); return "ok"; }));
        assertEquals(3, calls.get()); assertEquals(2, slept.size());
        for (Duration d : slept) assertTrue(d.toMillis() <= 400, "jittered backoff within the cap");
        calls.set(0);
        assertThrows(IllegalStateException.class, () -> r.call(() -> { calls.incrementAndGet(); throw new IllegalStateException("400 bad request"); }));
        assertEquals(1, calls.get(), "a 4xx is never retried");
    }

    @Test void timeoutBecomesTransientFailure() {
        Resilient r = new Resilient(Duration.ofMillis(50), new CircuitBreaker("t", 100, Duration.ofSeconds(1), Clock.systemUTC()), RetryPolicy.none());
        assertThrows(TransientFailure.class, () -> r.call(() -> { try { Thread.sleep(2000); } catch (InterruptedException e) { } return "late"; }));
    }

    @Test void circuitBreakerOpensFailsFastAndRecovers() {
        Instant[] now = {Instant.parse("2026-10-20T00:00:00Z")};
        Clock clock = new Clock() { public ZoneOffset getZone() { return ZoneOffset.UTC; } public Clock withZone(java.time.ZoneId z) { return this; } public Instant instant() { return now[0]; } };
        CircuitBreaker b = new CircuitBreaker("sms", 3, Duration.ofSeconds(30), clock);
        AtomicInteger calls = new AtomicInteger();
        for (int i = 0; i < 3; i++) assertThrows(TransientFailure.class, () -> b.call(() -> { calls.incrementAndGet(); throw new TransientFailure("down"); }));
        assertEquals(CircuitBreaker.State.OPEN, b.state());
        assertThrows(CircuitBreaker.OpenException.class, () -> b.call(() -> { calls.incrementAndGet(); return 1; }));
        assertEquals(3, calls.get(), "open breaker does not call the provider");
        now[0] = now[0].plusSeconds(31);
        assertEquals(1, (int) b.call(() -> 1));
        assertEquals(CircuitBreaker.State.CLOSED, b.state());
    }

    @Test void jsonRefusesUnknownFieldsAndCarriesMoneyAsString() throws Exception {
        ObjectMapper m = Json.mapper();
        assertEquals(Money.of("3540.00"), m.readValue("{\"unitId\":\"x\",\"amount\":\"3540\"}", Req.class).amount());
        assertThrows(Exception.class, () -> m.readValue("{\"unitId\":\"x\",\"amount\":\"1\",\"createdBy\":\"me\"}", Req.class), "unknown property");
        assertThrows(Exception.class, () -> m.readValue("{\"unitId\":\"x\",\"amount\":\"1.234\"}", Req.class), "three decimals");
        assertThrows(Exception.class, () -> m.readValue("{\"unitId\":\"x\",\"amount\":true}", Req.class), "not a number");
        assertEquals("{\"unitId\":\"x\",\"amount\":\"12.50\"}", m.writeValueAsString(new Req("x", Money.of("12.5"))));
        assertEquals("\"" + Fixtures.UNIT_A.value() + "\"", m.writeValueAsString(Fixtures.UNIT_A), "ids as plain strings");
    }

    record Dec(java.math.BigDecimal amount, Integer count) {}
    @Test void jsonReadsADecimalWrittenAsAStringButNothingLooser() throws Exception {
        ObjectMapper m = Json.mapper();
        assertEquals(new java.math.BigDecimal("1180.00"), m.readValue("{\"amount\":\"1180.00\"}", Dec.class).amount(), "how the apps send amounts");
        assertEquals(new java.math.BigDecimal("18"), m.readValue("{\"amount\":18}", Dec.class).amount());
        assertNull(m.readValue("{\"amount\":\"\"}", Dec.class).amount());
        assertThrows(Exception.class, () -> m.readValue("{\"amount\":\"1,180\"}", Dec.class), "not a plain decimal");
        assertThrows(Exception.class, () -> m.readValue("{\"amount\":\"NaN\"}", Dec.class));
        assertThrows(Exception.class, () -> m.readValue("{\"count\":\"5\"}", Dec.class), "other numbers stay strict");
    }

    @Test void idempotencyReplaysSameRequestAndRefusesADifferentOne() {
        Map<String, Idempotency.Stored> store = new HashMap<>();
        Idempotency.Store s = new Idempotency.Store() {
            public boolean begin(Caller c, String k, byte[] h) { return store.putIfAbsent(k, new Idempotency.Stored(h, false, 0, null, null)) == null; }
            public Optional<Idempotency.Stored> find(Caller c, String k) { return Optional.ofNullable(store.get(k)); }
            public void complete(Caller c, String k, int st, Map<String, String> hd, byte[] b) { store.put(k, new Idempotency.Stored(store.get(k).requestHash(), true, st, hd, b)); }
            public void abandon(Caller c, String k) { store.remove(k); }
        };
        Idempotency idem = new Idempotency(s);
        Caller c = Fixtures.treasurer();
        AtomicInteger runs = new AtomicInteger();
        java.util.function.Supplier<Idempotency.Reply> made = () -> new Idempotency.Reply(201, Map.of("ETag", "\"3\""), ("{\"n\":" + runs.incrementAndGet() + "}").getBytes(), false);
        Idempotency.Reply first = idem.run(c, "key-12345", "POST /x", "{\"a\":1}".getBytes(), made);
        Idempotency.Reply again = idem.run(c, "key-12345", "POST /x", "{\"a\":1}".getBytes(), made);
        assertEquals(1, runs.get()); assertEquals(new String(first.body()), new String(again.body())); assertTrue(again.replayed()); assertEquals("\"3\"", again.headers().get("ETag"));
        DomainException e = assertThrows(DomainException.class, () -> idem.run(c, "key-12345", "POST /x", "{\"a\":2}".getBytes(), made));
        assertEquals("idempotency-key-reused", e.code());
        assertThrows(DomainException.class, () -> idem.run(c, "kk", "POST /x", new byte[0], made), "key too short");
        assertThrows(IllegalStateException.class, () -> idem.run(c, "key-fails-1", "POST /x", new byte[0], () -> { throw new IllegalStateException("boom"); }));
        assertFalse(store.containsKey("key-fails-1"), "a failed request frees its key for the retry");
        idem.run(c, "key-refused", "POST /x", new byte[0], () -> new Idempotency.Reply(422, Map.of(), "{}".getBytes(), false));
        assertFalse(store.containsKey("key-refused"), "a refusal is not kept: the corrected retry runs");
        assertTrue(com.communityos.api.shared.web.IdempotencyFilter.class.getSimpleName().length() > 0);
    }

    @Test void outboxRelayRetriesWithBackoffThenGivesUp() {
        Map<Long, String> state = new HashMap<>();
        Map<Long, Integer> attempts = new HashMap<>();
        List<OutboxMessage> pending = new ArrayList<>();
        for (long i = 1; i <= 3; i++) { pending.add(new OutboxMessage(i, UUID.randomUUID(), Fixtures.COMMUNITY.value(), "billing.due.paid", "billing.due", UUID.randomUUID(), "{}", i == 3 ? 9 : 0, Instant.now())); }
        OutboxRelay.Store store = new OutboxRelay.Store() {
            public List<OutboxMessage> claimDue(int batch, Instant now) { return pending; }
            public void markSent(long id, Instant at) { state.put(id, "Sent"); }
            public void retryLater(long id, int a, Instant next, String err) { state.put(id, "Retry"); attempts.put(id, a); assertTrue(next.isAfter(Instant.now())); }
            public void markDead(long id, int a, String err) { state.put(id, "Dead"); }
        };
        EventPublisher pub = (m) -> {
            if (m.id() == 1) return;
            if (m.id() == 2) throw new TransientFailure("receiver down");
            throw new TransientFailure("still down");
        };
        assertEquals(1, new OutboxRelay(store, pub, 10, Clock.systemUTC()).runOnce(10));
        assertEquals("Sent", state.get(1L)); assertEquals("Retry", state.get(2L)); assertEquals(1, (int) attempts.get(2L)); assertEquals("Dead", state.get(3L), "10th attempt gives up");
        EventPublisher bad = (m) -> { throw new IllegalArgumentException("unserialisable"); };
        pending.clear(); pending.add(new OutboxMessage(4, UUID.randomUUID(), Fixtures.COMMUNITY.value(), "a.b.c", "a.b", UUID.randomUUID(), "{}", 0, Instant.now()));
        new OutboxRelay(store, bad, 10, Clock.systemUTC()).runOnce(10);
        assertEquals("Dead", state.get(4L), "a non-transient failure is not retried");
    }

    @Test void customFieldsAcceptOnlyDefinedTypedKeys() {
        UUID committee = UUID.randomUUID();
        CustomFields cf = new CustomFields((entity) -> List.of(
            new CustomFields.Definition("parkingSlot", "text", false, List.of(), Set.of()),
            new CustomFields.Definition("pets", "number", false, List.of(), Set.of()),
            new CustomFields.Definition("facing", "select", false, List.of("East", "West"), Set.of()),
            new CustomFields.Definition("rebate", "money", false, List.of(), Set.of(committee))));
        Map<String, Object> out = cf.apply("property.unit", Map.of(), Map.of("parkingSlot", "P-12", "pets", 2, "facing", "East"), Set.of());
        assertEquals("P-12", out.get("parkingSlot")); assertEquals(new java.math.BigDecimal("2"), out.get("pets"));
        assertThrows(DomainException.class, () -> cf.apply("property.unit", Map.of(), Map.of("createdBy", "x"), Set.of()), "unknown key");
        assertThrows(DomainException.class, () -> cf.apply("property.unit", Map.of(), Map.of("pets", "many"), Set.of()), "wrong type");
        assertThrows(DomainException.class, () -> cf.apply("property.unit", Map.of(), Map.of("facing", "North"), Set.of()), "not an option");
        assertThrows(DomainException.class, () -> cf.apply("property.unit", Map.of(), Map.of("rebate", "100"), Set.of()), "edit-restricted field");
        assertEquals(new java.math.BigDecimal("100"), cf.apply("property.unit", Map.of(), Map.of("rebate", "100"), Set.of(committee)).get("rebate"));
        Map<String, Object> rm = new HashMap<>(); rm.put("pets", null);
        assertFalse(cf.apply("property.unit", Map.of("pets", 1), rm, Set.of()).containsKey("pets"), "null removes");
    }
}
