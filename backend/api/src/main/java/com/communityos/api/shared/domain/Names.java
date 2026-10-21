package com.communityos.api.shared.domain;

import java.util.Collection;
import java.util.Locale;

/** Comparing names people type: case and extra spaces do not make a different name. */
public final class Names {
    private Names() {}
    /** Trimmed, single spaces. */
    public static String tidy(String s) { return s == null ? null : s.strip().replaceAll("\\s+", " "); }
    /** The key two names are compared by. */
    public static String key(String s) { return s == null ? null : tidy(s).toLowerCase(Locale.ROOT); }
    public static boolean same(String a, String b) { return a == null ? b == null : b != null && key(a).equals(key(b)); }
    /** The list's own spelling of `v` ("plumbing" -> "Plumbing"), or null when it is not in the list. */
    public static String pick(Collection<String> allowed, String v) {
        if (v == null) return null;
        for (String a : allowed) if (same(a, v)) return a;
        return null;
    }
    /** An e-mail address as it is stored: trimmed, lower case (null when blank). */
    public static String email(String s) { return s == null || s.isBlank() ? null : s.strip().toLowerCase(Locale.ROOT); }
}
