package com.communityos.api.identity.domain;

import com.communityos.api.shared.domain.DomainException;

/** A phone number in E.164 (+919876543210). Ten-digit local numbers get the community region's code (+91 by default). */
public record Phone(String e164) {
    public Phone {
        if (e164 == null || !e164.matches("\\+[1-9][0-9]{6,14}")) throw new DomainException.RuleViolated("bad-phone", "Enter a valid mobile number");
    }
    public static Phone parse(String raw, String defaultCountryCode) {
        if (raw == null) throw new DomainException.RuleViolated("bad-phone", "Enter a valid mobile number");
        String s = raw.replaceAll("[\\s()-]", "");
        if (s.startsWith("00")) s = "+" + s.substring(2);
        if (s.matches("0?[6-9][0-9]{9}")) s = defaultCountryCode + s.substring(s.length() - 10);
        return new Phone(s);
    }
    /** +91•••••43210 for logs and messages. */
    public String masked() { return e164.substring(0, 3) + "•••••" + e164.substring(e164.length() - 5); }
    @Override public String toString() { return masked(); }
}
