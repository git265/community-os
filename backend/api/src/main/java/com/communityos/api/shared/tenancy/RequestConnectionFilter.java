package com.communityos.api.shared.tenancy;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;

/**
 * A read request's statements share one database connection (see TenantDataSource): GET / HEAD only, because a read never calls an outside
 * service, so the connection is never held while waiting on one. Writes keep their own short transactions, and the payment calls they make stay
 * outside any connection. The live notification stream is left out: it reads nothing, and it stays open for minutes.
 * Registered after the security filters, so the caller is known when the first statement runs.
 */
public final class RequestConnectionFilter implements Filter {
    @Override public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) throws IOException, ServletException {
        boolean bound = req.getDispatcherType() == DispatcherType.REQUEST && req instanceof HttpServletRequest h
            && ("GET".equals(h.getMethod()) || "HEAD".equals(h.getMethod())) && !h.getRequestURI().endsWith("/notifications/stream")
            && TenantDataSource.bind();
        if (bound) com.communityos.api.shared.web.Truncation.begin();      // and a list cut at its cap is reported (X-List-Truncated)
        try { chain.doFilter(req, res); }
        finally { if (bound) { TenantDataSource.release(); com.communityos.api.shared.web.Truncation.end(); } }
    }
}
