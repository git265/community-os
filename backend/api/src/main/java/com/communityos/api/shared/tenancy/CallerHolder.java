package com.communityos.api.shared.tenancy;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.CallerAuthentication;
import java.util.Optional;
import java.util.function.Supplier;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * The caller of the current request or job. For a request it is the CallerAuthentication Spring Security put in the security context after
 * verifying the bearer token; a job or webhook sets one explicitly with runAs. Read by TenantDataSource (to put the community on every
 * database connection), by the services and by the audit writer.
 */
public final class CallerHolder {
    private static final ThreadLocal<Caller> EXPLICIT = new ThreadLocal<>();
    private CallerHolder() {}

    public static Optional<Caller> current() {
        Caller c = EXPLICIT.get();
        if (c != null) return Optional.of(c);
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return a instanceof CallerAuthentication ca ? Optional.of(ca.caller()) : Optional.empty();
    }
    public static Caller require() {
        return current().orElseThrow(() -> new com.communityos.api.shared.security.AccessDenied("Sign in to continue"));
    }
    /** Run work as someone (a job as the system caller of one community, a webhook as the payment's community), then restore. */
    public static <T> T runAs(Caller c, Supplier<T> work) {
        Caller before = EXPLICIT.get();
        EXPLICIT.set(c);
        try { return work.get(); } finally { if (before == null) EXPLICIT.remove(); else EXPLICIT.set(before); }
    }
}
