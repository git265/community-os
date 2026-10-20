package com.communityos.idempotency;

import java.util.Optional;

/** PORT: the idempotency_keys table (db/V4). A plain unique key: no Redis needed to be correct. */
public interface IdempotencyStore {
    record Entry(String requestHash, String state, Integer status, String body, String contentType) {
        public boolean done() { return "Done".equals(state); }
    }

    /** @return true when this call is the first to use the key (it now owns it as InFlight) */
    boolean begin(String tenant, String scope, String key, String requestHash);
    Optional<Entry> find(String tenant, String scope, String key);
    void complete(String tenant, String scope, String key, int status, String body);
    /** A server error is not remembered: the retry runs for real. */
    void release(String tenant, String scope, String key);
    int cleanup(int olderThanHours);
}
