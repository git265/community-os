package com.communityos.logging;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Gives every request an id and logs one access line when it ends. The id comes from the caller's X-Request-Id (so the UI,
 * the proxy and this log agree) or is made here; it is put in the logging context (%X{requestId} in every line of the request),
 * returned in the X-Request-Id response header, and also appears in error bodies. Runs first, before the security filters.
 * Only the path, status and time are logged. Never headers, query strings or bodies (they can carry tokens and personal data).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestLoggingFilter extends OncePerRequestFilter {
    public static final String HEADER = "X-Request-Id";
    public static final String MDC_KEY = "requestId";
    private static final Pattern SAFE = Pattern.compile("^[A-Za-z0-9._-]{8,64}$");   // an id from outside is accepted only in this shape
    private static final Logger access = LoggerFactory.getLogger("com.communityos.access");

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return path.startsWith("/actuator") || path.startsWith("/swagger-ui") || path.startsWith("/v3/api-docs");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String given = req.getHeader(HEADER);
        String id = given != null && SAFE.matcher(given).matches() ? given : UUID.randomUUID().toString();
        MDC.put(MDC_KEY, id);
        String community = req.getHeader("X-Community-Id");
        if (community != null && community.matches("^[a-z0-9-]{1,32}$")) MDC.put("community", community);
        MDC.put("clientIp", req.getRemoteAddr());   // written into every audit line this request makes (behind a proxy: set server.forward-headers-strategy=native)
        res.setHeader(HEADER, id);
        long start = System.nanoTime();
        try {
            chain.doFilter(req, res);
        } finally {
            long ms = (System.nanoTime() - start) / 1_000_000;
            int status = res.getStatus();
            String line = "{} {} -> {} in {} ms";
            if (status >= 500) access.error(line, req.getMethod(), req.getRequestURI(), status, ms);
            else if (status >= 400 || ms > 1000) access.warn(line, req.getMethod(), req.getRequestURI(), status, ms);
            else access.info(line, req.getMethod(), req.getRequestURI(), status, ms);
            MDC.clear();
        }
    }
}
