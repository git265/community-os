package com.communityos.api.gate.domain;

import com.communityos.api.shared.domain.DomainException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * A staff member's gate badge: {@code GGB|<member>|<window>|<mac>}, a new code every 30 seconds. The mac is HMAC-SHA256 of member and
 * window under the community's key (64 bits shown). The gate accepts the current window or the one either side (clock skew) and the
 * caller makes sure a window is used once.
 */
public final class StaffBadge {
    private StaffBadge() {}
    public static final long STEP_SECONDS = 30;
    static final Pattern TEXT = Pattern.compile("^GGB\\|([0-9a-fA-F-]{36})\\|(\\d{1,12})\\|([0-9a-f]{16})$");

    public record Code(UUID member, long window) {}

    public static long window(Instant at) { return at.getEpochSecond() / STEP_SECONDS; }
    public static String text(byte[] key, UUID member, Instant at) { long w = window(at); return "GGB|" + member + "|" + w + "|" + mac(key, member, w); }
    public static int secondsLeft(Instant at) { return (int) (STEP_SECONDS - at.getEpochSecond() % STEP_SECONDS); }

    /** The member and window of a genuine, current code; otherwise a rule the guard can read out. */
    public static Code check(byte[] key, String text, Instant now) {
        Matcher m = TEXT.matcher(text == null ? "" : text.strip());
        if (!m.matches()) throw new DomainException.RuleViolated("not-a-badge", "This is not a staff badge");
        UUID member;
        try { member = UUID.fromString(m.group(1)); } catch (IllegalArgumentException e) { throw new DomainException.RuleViolated("not-a-badge", "This is not a staff badge"); }
        long w = Long.parseLong(m.group(2)); long cur = window(now);
        if (w > cur + 1 || w < cur - 1) throw new DomainException.RuleViolated("badge-old", "This badge code is old. Ask the person to open their badge again; screenshots do not work.");
        byte[] want = mac(key, member, w).getBytes(StandardCharsets.US_ASCII);
        if (!MessageDigest.isEqual(want, m.group(3).getBytes(StandardCharsets.US_ASCII))) throw new DomainException.RuleViolated("badge-invalid", "The badge code is not valid");
        return new Code(member, w);
    }

    static String mac(byte[] key, UUID member, long window) {
        try {
            Mac h = Mac.getInstance("HmacSHA256");
            h.init(new SecretKeySpec(key, "HmacSHA256"));
            byte[] full = h.doFinal((member + "|" + window).getBytes(StandardCharsets.US_ASCII));
            return HexFormat.of().formatHex(full, 0, 8);
        } catch (GeneralSecurityException e) { throw new IllegalStateException("HmacSHA256 is not available", e); }
    }
}
