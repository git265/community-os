package com.communityos.api.shared.web;

import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.Caller;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * Idempotency-Key for every POST (IdempotencyFilter applies it to all of them, one place): a retry after a network drop gets the SAME answer -
 * status, body and the ETag / Location headers - and does nothing again. The key is per caller; the same key with a different request is
 * refused; a request still running answers 409. Only a success is kept (a refusal or an error frees the key for the retry). Replies are
 * kept 24 h (integration.idempotency_key). The key must be 8-128 characters.
 */
public final class Idempotency {
    /** A stored reply: the request's hash, done or still running, and what was answered. */
    public record Stored(byte[] requestHash, boolean done, int status, Map<String, String> headers, byte[] body) {}
    /** An answer to keep and give again. */
    public record Reply(int status, Map<String, String> headers, byte[] body, boolean replayed) {}

    /** Port over integration.idempotency_key. */
    public interface Store {
        /** Insert an InFlight row; false if one exists for this caller and key. */
        boolean begin(Caller caller, String key, byte[] requestHash);
        Optional<Stored> find(Caller caller, String key);
        void complete(Caller caller, String key, int status, Map<String, String> headers, byte[] body);
        void abandon(Caller caller, String key);
    }

    static final java.util.regex.Pattern KEY = java.util.regex.Pattern.compile("[A-Za-z0-9_\\-:.]{8,128}");
    private final Store store;
    public Idempotency(Store store) { this.store = store; }

    /** Run `work` once for this caller and key; a repeat of the same request gets the first success again. */
    public Reply run(Caller caller, String key, String operation, byte[] body, Supplier<Reply> work) {
        if (!KEY.matcher(key).matches()) throw new DomainException.RuleViolated("bad-idempotency-key", "Idempotency-Key must be 8-128 letters, digits or - _ : .");
        byte[] op = (operation + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8), b = body == null ? new byte[0] : body;
        byte[] all = java.util.Arrays.copyOf(op, op.length + b.length); System.arraycopy(b, 0, all, op.length, b.length);
        byte[] hash = Crypto.sha256(all);                                                     // method + path + body
        if (!store.begin(caller, key, hash)) {
            Stored s = store.find(caller, key).orElseThrow(() -> new DomainException.Conflict("This request"));
            if (!Crypto.constantTimeEquals(s.requestHash(), hash))
                throw new DomainException.RuleViolated("idempotency-key-reused", "This Idempotency-Key was already used for a different request");
            if (!s.done()) throw new DomainException.Conflict("The same request is still being processed; it");
            return new Reply(s.status(), s.headers() == null ? Map.of() : s.headers(), s.body(), true);
        }
        Reply out;
        try { out = work.get(); }
        catch (RuntimeException e) { store.abandon(caller, key); throw e; }
        if (out.status() >= 200 && out.status() < 300) store.complete(caller, key, out.status(), out.headers(), out.body());
        else store.abandon(caller, key);
        return out;
    }
}
