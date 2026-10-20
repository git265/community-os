package com.communityos.web;

import java.util.Set;
import java.util.regex.Pattern;

/** Validation of every name that reaches SQL or a file path. Names are checked here AND always passed as bind parameters. */
public final class Names {
    private Names() {}

    private static final Pattern TENANT = Pattern.compile("^(platform|[a-z0-9][a-z0-9-]{1,30}[a-z0-9])$");
    private static final Pattern COLLECTION = Pattern.compile("^[A-Za-z][A-Za-z0-9_:-]{0,63}$");
    private static final Pattern KEY = Pattern.compile("^[A-Za-z0-9_.-]{1,64}$");
    private static final Pattern ID = Pattern.compile("^[^/\\\\?%\\p{Cntrl}]{1,128}$"); // anything but / \ ? % and control characters, so a path stays one segment
    /** Words used by fixed routes (/api/health, /api/payments/...). A collection cannot use them. */
    private static final Set<String> RESERVED = Set.of("health", "admin", "payments", "gst");

    public static String tenant(String v) { return check(TENANT, v, "Send a valid X-Community-Id header."); }
    public static String collection(String v) {
        check(COLLECTION, v, "Bad collection name.");
        if (RESERVED.contains(v)) throw new BadRequestException("That collection name is reserved.");
        return v;
    }
    public static String key(String v) { return check(KEY, v, "Bad field name: " + v); }
    public static String id(String v) { return check(ID, v, "Bad id."); }

    private static String check(Pattern p, String v, String message) {
        if (v == null || !p.matcher(v).matches()) throw new BadRequestException(message);
        return v;
    }
}
