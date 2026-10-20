package com.communityos.amenities;

/**
 * `String.prototype.localeCompare` as Node's ICU answers it for the characters a booking slot is made of ("17:30 - 18:30", "Full day"):
 * spaces and punctuation first, then digits, then letters; letters ignore case until everything else is equal, then lower case comes first.
 * Characters beyond ASCII sort after it, by code point (ICU has a far richer table: a slot is not expected to hold such text).
 */
public final class IcuCompare {
    private IcuCompare() {}
    /** The ASCII order ICU gives (letters in lower case; the upper-case twin has the same rank). */
    private static final String ORDER = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

    private static int rank(char c) {
        char l = c >= 'A' && c <= 'Z' ? (char) (c + 32) : c;
        int i = ORDER.indexOf(l);
        return i >= 0 ? i : 1000 + l;
    }

    public static int compare(String a, String b) {
        int n = Math.min(a.length(), b.length());
        for (int i = 0; i < n; i++) {
            int d = Integer.compare(rank(a.charAt(i)), rank(b.charAt(i)));
            if (d != 0) return d;
        }
        if (a.length() != b.length()) return Integer.compare(a.length(), b.length());
        for (int i = 0; i < n; i++) {   // same letters: lower case first
            char x = a.charAt(i), y = b.charAt(i);
            if (x != y) return Character.isLowerCase(x) ? -1 : 1;
        }
        return 0;
    }

    /**
     * `a.localeCompare(b, undefined, { numeric: true })`: a run of digits counts as one number ("A-9" before "A-10"), the rest as above.
     * (Numbers written with leading zeros are not told apart from the same number without them; a unit name does not have those.)
     */
    public static int compareNumeric(String a, String b) {
        int i = 0, j = 0;
        while (i < a.length() && j < b.length()) {
            char x = a.charAt(i), y = b.charAt(j);
            boolean dx = x >= '0' && x <= '9', dy = y >= '0' && y <= '9';
            if (dx && dy) {
                int ei = i, ej = j;
                while (ei < a.length() && a.charAt(ei) >= '0' && a.charAt(ei) <= '9') ei++;
                while (ej < b.length() && b.charAt(ej) >= '0' && b.charAt(ej) <= '9') ej++;
                java.math.BigInteger p = new java.math.BigInteger(a.substring(i, ei)), q = new java.math.BigInteger(b.substring(j, ej));
                int d = p.compareTo(q);
                if (d != 0) return d;
                i = ei; j = ej;
                continue;
            }
            int d = Integer.compare(rank(x), rank(y));
            if (d != 0) return d;
            i++; j++;
        }
        if (i < a.length()) return 1;
        if (j < b.length()) return -1;
        return compare(a, b) == 0 ? 0 : compareCase(a, b);
    }

    private static int compareCase(String a, String b) {
        int n = Math.min(a.length(), b.length());
        for (int i = 0; i < n; i++) { char x = a.charAt(i), y = b.charAt(i); if (x != y) return Character.isLowerCase(x) ? -1 : 1; }
        return Integer.compare(a.length(), b.length());
    }
}
