package com.communityos.api.shared.domain;

import java.util.Locale;

/**
 * An Indian GST registration number (GSTIN): 2-digit state code, the 10-character PAN, an entity number, 'Z', and a check character computed
 * from the first 14 (mod 36). The same rule runs in the app (src/lib/finance/itc.js validateGstin), so a typing mistake is caught when the
 * vendor is saved rather than when input credit is checked months later. A blank GSTIN is allowed: the vendor is not registered for GST.
 */
public final class Gstin {
    private static final String CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    public static final String EXAMPLE = "29ABCDE1234F1ZW";
    private Gstin() {}

    static char checkChar(String first14) {
        int sum = 0;
        for (int i = 0; i < 14; i++) { int p = CHARS.indexOf(first14.charAt(i)) * (i % 2 == 0 ? 1 : 2); sum += p / 36 + p % 36; }
        return CHARS.charAt((36 - sum % 36) % 36);
    }

    /** The GSTIN as stored (upper case, trimmed), or null for blank; refuses a wrong shape or a wrong check character. */
    public static String check(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String g = raw.strip().toUpperCase(Locale.ROOT);
        if (!g.matches("[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]"))
            throw new DomainException.RuleViolated("bad-gstin", "A GSTIN is 15 characters, like " + EXAMPLE);
        if (checkChar(g) != g.charAt(14))
            throw new DomainException.RuleViolated("bad-gstin", "GSTIN " + g + " is not valid: its last character is a check on the first 14 and does not match (for those 14 it would be " + checkChar(g) + "), so a character was probably typed wrong. Copy it again from the vendor's GST certificate or invoice.");
        return g;
    }
}
