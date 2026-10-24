package com.communityos.api.identity.domain;

import com.communityos.api.shared.domain.DomainException;

/** A phone number in E.164 (+919876543210). Ten-digit local numbers get the community region's code (+91 by default). */
public record Phone(String e164) {
    public Phone {
        if (e164 == null || !e164.matches("\\+[1-9][0-9]{6,14}")) throw new DomainException.RuleViolated("bad-phone", "Enter a valid phone number with the country code, e.g. +91 98450 71234");
    }
    public static Phone parse(String raw, String defaultCountryCode) {
        if (raw == null) throw new DomainException.RuleViolated("bad-phone", "Enter a valid phone number with the country code, e.g. +91 98450 71234");
        String s = raw.replaceAll("[\\s()-]", "");
        if (s.startsWith("00")) s = "+" + s.substring(2);
        if (s.matches("0?[6-9][0-9]{9}")) s = defaultCountryCode + s.substring(s.length() - 10);
        Phone p = new Phone(s);
        // the same checks as the app (lib/phone.js): an Indian number has 10 digits and does not start with 0; no placeholders
        if (s.startsWith("+91") && !s.matches("\\+91[1-9][0-9]{9}")) throw new DomainException.RuleViolated("bad-phone", "An Indian number has 10 digits after +91");
        if (placeholder(s.startsWith("+91") ? s.substring(3) : s.substring(1))) throw new DomainException.RuleViolated("bad-phone", "This looks like a placeholder number - enter the real one");
        return p;
    }
    /** 9999999999, 1234567890, 1212121212 ... */
    static boolean placeholder(String digits) {
        if (digits.length() < 6) return false;
        if (digits.chars().distinct().count() == 1) return true;
        if ("01234567890123456789".contains(digits) || "98765432109876543210".contains(digits)) return true;
        return digits.length() >= 8 && digits.chars().distinct().count() <= 2;
    }
    /** +91•••••43210 for logs and messages. */
    public String masked() { return e164.substring(0, 3) + "•••••" + e164.substring(e164.length() - 5); }
    @Override public String toString() { return masked(); }
}
