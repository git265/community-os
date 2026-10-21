package com.communityos.api.shared.tx;

import java.util.function.Supplier;

/**
 * Port: run work in one database transaction (commit on return, roll back on any exception). The application layer depends on this, not on
 * Spring, so use cases are tested without a database. SpringTx adapts a TransactionTemplate; there is one for the tenant (cos_app) pool and
 * one for the platform pool.
 */
@FunctionalInterface
public interface Tx {
    <T> T inTx(Supplier<T> work);
    default void run(Runnable work) { inTx(() -> { work.run(); return null; }); }
    /** For tests and for code that is already inside a transaction. */
    static Tx direct() { return new Tx() { @Override public <T> T inTx(Supplier<T> work) { return work.get(); } }; }
}
