package com.communityos.api.shared.tx;

import java.util.function.Supplier;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Tx over Spring's TransactionTemplate (READ COMMITTED; aggregates use optimistic versions and row locks where it matters). */
public final class SpringTx implements Tx {
    private final TransactionTemplate template;
    public SpringTx(PlatformTransactionManager tm, int timeoutSeconds) {
        template = new TransactionTemplate(tm);
        template.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        template.setTimeout(timeoutSeconds);
    }
    @Override public <T> T inTx(Supplier<T> work) { return template.execute((status) -> work.get()); }
}
