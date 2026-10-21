package com.communityos.api.shared.crypto;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** The few primitives the API needs: HMAC-SHA256, SHA-256, constant-time comparison and unguessable tokens. */
public final class Crypto {
    private static final SecureRandom RANDOM = new SecureRandom();
    private Crypto() {}

    public static byte[] hmacSha256(byte[] key, byte[] data) {
        try { Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256")); return mac.doFinal(data); }
        catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }
    public static byte[] hmacSha256(String key, String data) { return hmacSha256(utf8(key), utf8(data)); }
    public static String hmacHex(String key, String data) { return HexFormat.of().formatHex(hmacSha256(key, data)); }
    public static String hmacHex(String key, byte[] data) { return HexFormat.of().formatHex(hmacSha256(utf8(key), data)); }
    public static byte[] sha256(byte[] data) {
        try { return MessageDigest.getInstance("SHA-256").digest(data); } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }
    public static byte[] sha256(String s) { return sha256(utf8(s)); }
    /** Same time whatever the input, so a signature or code cannot be guessed byte by byte from response times. */
    public static boolean constantTimeEquals(byte[] a, byte[] b) { return a != null && b != null && MessageDigest.isEqual(a, b); }
    public static boolean constantTimeEquals(String a, String b) { return a != null && b != null && MessageDigest.isEqual(utf8(a), utf8(b)); }
    /** A random token, base64url without padding: 32 bytes = 256 bits. */
    public static String randomToken(int bytes) { byte[] b = new byte[bytes]; RANDOM.nextBytes(b); return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }
    /** A random numeric code of n digits (uniform, no modulo bias). */
    public static String randomDigits(int n) { StringBuilder sb = new StringBuilder(n); for (int i = 0; i < n; i++) sb.append(RANDOM.nextInt(10)); return sb.toString(); }
    public static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }
}
