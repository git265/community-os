package com.communityos.api.shared.resource;

import com.communityos.api.shared.domain.DomainException;
import java.math.BigDecimal;
import java.util.Collection;
import java.util.List;

/** Small field checks used by resource rules; each throws a RuleViolated with a sentence a person can act on. */
public final class Checks {
    private Checks() {}
    public static String required(String v, String label) {
        if (v == null || v.isBlank()) throw new DomainException.RuleViolated("required", label + " is required");
        return text(v, label, 500);
    }
    public static String text(String v, String label, int max) {
        if (v == null) return null;
        String s = v.strip();
        if (s.length() > max) throw new DomainException.RuleViolated("too-long", label + " is too long (up to " + max + " characters)");
        return s.isEmpty() ? null : s;
    }
    public static String oneOf(String v, String label, Collection<String> allowed) {
        if (v == null || v.isBlank()) return null;
        String k = com.communityos.api.shared.domain.Names.pick(allowed, v);     // "plumbing" is "Plumbing": the list's own spelling is kept
        if (k == null) throw new DomainException.RuleViolated("bad-" + label.toLowerCase().replace(' ', '-'), label + " must be one of: " + String.join(", ", allowed));
        return k;
    }
    public static String requiredOneOf(String v, String label, Collection<String> allowed) {
        if (v == null || v.isBlank()) throw new DomainException.RuleViolated("required", label + " is required");
        return oneOf(v, label, allowed);
    }
    public static BigDecimal nonNegative(BigDecimal v, String label) {
        if (v != null && v.signum() < 0) throw new DomainException.RuleViolated("negative", label + " cannot be negative");
        return v;
    }
    public static Integer nonNegative(Integer v, String label) {
        if (v != null && v < 0) throw new DomainException.RuleViolated("negative", label + " cannot be negative");
        return v;
    }
    /** Empty, or a number from `min` to `max` (inclusive). */
    public static BigDecimal between(BigDecimal v, String label, long min, long max) {
        if (v != null && (v.compareTo(BigDecimal.valueOf(min)) < 0 || v.compareTo(BigDecimal.valueOf(max)) > 0))
            throw new DomainException.RuleViolated("out-of-range", label + " is from " + min + " to " + max);
        return v;
    }
    /** A value that must be given (a date, an amount, a choice). */
    public static <T> T present(T v, String label) { if (v == null || (v instanceof String s && s.isBlank())) throw new DomainException.RuleViolated("required", label + " is required"); return v; }
    /** An amount that must be given and above zero. */
    public static BigDecimal positive(BigDecimal v, String label) { if (v == null || v.signum() <= 0) throw new DomainException.RuleViolated("required", label + " must be more than zero"); return v; }
    /** A phone number as the app checks it (E.164, real digits, no placeholder), normalised; empty allowed unless required. */
    public static String phone(String raw, String label, boolean required) {
        if (raw == null || raw.isBlank()) { if (required) throw new DomainException.RuleViolated("required", label + " is required"); return null; }
        return com.communityos.api.identity.domain.Phone.parse(raw, "+91").e164();
    }
    public static <T> List<T> list(List<T> v) { return v == null ? List.of() : v; }
    public static void rule(boolean ok, String code, String message) { if (!ok) throw new DomainException.RuleViolated(code, message); }
}
