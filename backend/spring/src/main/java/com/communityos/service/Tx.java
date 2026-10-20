package com.communityos.service;

import java.sql.SQLException;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Runs a piece of work in ONE database transaction. Repositories do not start transactions themselves; the service that knows the whole
 * unit of work does, here. `serializable` and `repeatableRead` are for money: PostgreSQL then aborts one of two conflicting transactions
 * (SQLSTATE 40001, or 40P01 on a deadlock). That is not an error for the caller: the whole unit is simply run again (up to 4 times),
 * now seeing the other one's result.
 */
@Component
public class Tx {
    private static final Logger log = LoggerFactory.getLogger(Tx.class);
    private static final int ATTEMPTS = 4;

    private final Object memoryLock = new Object();   // no database: money steps queue up here, as row locks make them queue up in PostgreSQL
    private final PlatformTransactionManager tm;   // null with no database (profile `memory`): the work then simply runs

    @Autowired
    public Tx(ObjectProvider<PlatformTransactionManager> tm) { this.tm = tm.getIfAvailable(); }

    /** No database (unit tests, profile `memory`): the work simply runs, money steps one at a time. */
    public static Tx none() { return new Tx((PlatformTransactionManager) null); }

    /** For tests and for code that already has the manager (null = no transactions). */
    Tx(PlatformTransactionManager tm) { this.tm = tm; }

    public <T> T run(Supplier<T> work) { return tm == null ? work.get() : template(TransactionDefinition.ISOLATION_DEFAULT).execute(s -> work.get()); }

    public void run(Runnable work) { run(() -> { work.run(); return null; }); }

    /** Its own transaction, committed whatever happens to the one around it (a used-up e-voting proof stays used up when the vote that presented it is refused). */
    public <T> T runIndependent(Supplier<T> work) {
        if (tm == null) return work.get();
        TransactionTemplate t = new TransactionTemplate(tm);
        t.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        return t.execute(s -> work.get());
    }

    /** Reads and writes see one consistent snapshot; a conflicting writer makes one side retry. */
    public <T> T repeatableRead(Supplier<T> work) { return retrying(TransactionDefinition.ISOLATION_REPEATABLE_READ, work); }

    public <T> T serializable(Supplier<T> work) { return retrying(TransactionDefinition.ISOLATION_SERIALIZABLE, work); }

    private <T> T retrying(int isolation, Supplier<T> work) {
        for (int attempt = 1; ; attempt++) {
            try {
                if (tm == null) { synchronized (memoryLock) { return work.get(); } }
                return template(isolation).execute(s -> work.get());
            } catch (RuntimeException e) {
                if (!isRetryable(e) || attempt >= ATTEMPTS) throw e;
                log.info("transaction conflict (attempt {}), running it again", attempt);
                try { Thread.sleep(15L * attempt + ThreadLocalRandom.current().nextInt(25)); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); throw e; }
            }
        }
    }

    /** 40001 = serialization failure, 40P01 = deadlock detected. */
    static boolean isRetryable(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException sql && ("40001".equals(sql.getSQLState()) || "40P01".equals(sql.getSQLState()))) return true;
            if (t.getCause() == t) break;
        }
        return false;
    }

    private TransactionTemplate template(int isolation) {
        TransactionTemplate t = new TransactionTemplate(tm);
        t.setIsolationLevel(isolation);
        return t;
    }
}
