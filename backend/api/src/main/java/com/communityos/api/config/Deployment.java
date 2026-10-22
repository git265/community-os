package com.communityos.api.config;

import org.springframework.core.env.Environment;

/**
 * Where the server runs. Strict unless a "dev" or "test" profile is active: a deployment that forgets to set its profile is treated as
 * production, so the development helpers (codes in the log, the simulated bank, the simulated scanner, the demo sign-in, throw-away signing
 * keys) are refused instead of quietly switched on.
 */
public final class Deployment {
    private Deployment() {}
    public static boolean strict(Environment env) { return !env.matchesProfiles("dev", "test"); }
}
