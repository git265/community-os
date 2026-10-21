package com.communityos.api.shared.web;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lists that are not paged have a fixed cap (`... LIMIT 2000`). When a read request's list comes back exactly that long, more rows may exist that
 * the caller did not get: the response then says so in `X-List-Truncated: <cap>` (TruncationAdvice), so the app can tell the person to narrow
 * the list instead of silently showing part of it. Only literal caps count; paged lists (`LIMIT :limit`) carry their own total.
 * Recorded only inside a read request (RequestConnectionFilter begins and ends it); jobs record nothing.
 */
public final class Truncation {
    public static final String HEADER = "X-List-Truncated";
    private static final Pattern CAP = Pattern.compile("(?is)\\bLIMIT\\s+(\\d+)\\s*$");
    private static final ThreadLocal<int[]> SEEN = new ThreadLocal<>();   // [0] = the cap reached (0 = none)
    private Truncation() {}

    public static void begin() { SEEN.set(new int[1]); }
    public static void end() { SEEN.remove(); }
    /** After a query: its rows reached the statement's own cap. */
    public static void check(String sql, int rows) {
        int[] seen = SEEN.get();
        if (seen == null || rows == 0) return;
        Matcher m = CAP.matcher(sql);
        if (m.find()) { int cap = Integer.parseInt(m.group(1)); if (rows >= cap) seen[0] = Math.max(seen[0], cap); }
    }
    /** The cap this request reached, or 0. */
    public static int reached() { int[] seen = SEEN.get(); return seen == null ? 0 : seen[0]; }
}
