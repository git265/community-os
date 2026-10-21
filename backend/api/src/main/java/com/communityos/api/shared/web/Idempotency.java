package com.communityos.api.shared.web;

import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.Caller;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * Idempotency-Key for POSTs that create something (a bill, a receipt, a payment order): a retry after a network drop gets the SAME answer and
 * creates nothing new. The key is per caller; the same key with a different request is refused; a request still running answers 409.
 * Stored replies are kept 24 h (integration.idempotency_key). The key must be 8-128 characters.
 */
public final class Idempotency {
    public record Stored(byte[] requestHash, boolean done, int status, byte[] body) {}

    /** Port over integration.idempotency_key. */
    public interface Store {
        /** Insert an InFlight row; false if one exists for this caller and key. */
        boolean begin(Caller caller, String key, byte[] requestHash);
        Optional<Stored> find(Caller caller, String key);
        void complete(Caller caller, String key, int status, byte[] body);
        void abandon(Caller caller, String key);
    }

    public record Reply<T>(int status, T body, boolean replayed) {}

    private final Store store; private final ObjectMapper json;
    public Idempotency(Store store, ObjectMapper json) { this.store = store; this.json = json; }

    public <T> Reply<T> run(Caller caller, String key, String operation, Object request, Class<T> type, int status, Supplier<T> work) {
        if (key == null) return new Reply<>(status, work.get(), false);
        if (key.length() < 8 || key.length() > 128 || !key.matches("[A-Za-z0-9_\\-:.]+"))
            throw new DomainException.RuleViolated("bad-idempotency-key", "Idempotency-Key must be 8-128 letters, digits or - _ : .");
        byte[] hash = Crypto.sha256(operation + "\n" + write(request));
        if (!store.begin(caller, key, hash)) {
            Stored s = store.find(caller, key).orElseThrow(() -> new DomainException.Conflict("This request"));
            if (!Crypto.constantTimeEquals(s.requestHash(), hash))
                throw new DomainException.RuleViolated("idempotency-key-reused", "This Idempotency-Key was already used for a different request");
            if (!s.done()) throw new DomainException.Conflict("The same request is still being processed; it");
            try { return new Reply<>(s.status(), json.readValue(s.body(), type), true); } catch (java.io.IOException e) { throw new IllegalStateException(e); }
        }
        try {
            T out = work.get();
            store.complete(caller, key, status, json.writeValueAsBytes(out));
            return new Reply<>(status, out, false);
        } catch (RuntimeException e) { store.abandon(caller, key); throw e; }
        catch (com.fasterxml.jackson.core.JsonProcessingException e) { store.abandon(caller, key); throw new IllegalStateException(e); }
    }

    private String write(Object o) { try { return json.writeValueAsString(o); } catch (Exception e) { throw new IllegalStateException(e); } }
}
