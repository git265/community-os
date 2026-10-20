package com.communityos.idempotency;

import com.communityos.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Forgets keys older than app.idempotency.hours (hourly). */
@Component
public class IdempotencyCleanup {
    private static final Logger log = LoggerFactory.getLogger(IdempotencyCleanup.class);
    private final IdempotencyStore store;
    private final AppProperties.Idempotency cfg;

    public IdempotencyCleanup(IdempotencyStore store, AppProperties props) { this.store = store; this.cfg = props.idempotency(); }

    @Scheduled(fixedDelay = 3_600_000L, initialDelay = 600_000L)
    public void run() {
        if (!cfg.enabled()) return;
        try { int n = store.cleanup(cfg.hours()); if (n > 0) log.info("forgot {} idempotency keys older than {} h", n, cfg.hours()); }
        catch (RuntimeException e) { log.warn("idempotency cleanup failed: {}", e.getMessage()); }
    }
}
