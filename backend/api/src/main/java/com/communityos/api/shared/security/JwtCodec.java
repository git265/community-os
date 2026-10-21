package com.communityos.api.shared.security;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Signs and verifies access tokens: compact JWS, ES256 (ECDSA P-256 / SHA-256) only. Verification refuses any other algorithm (no "none",
 * no HS256 key confusion), an unknown key id, a wrong issuer or audience, and an expired or not-yet-valid token (30 s clock skew).
 * Several public keys can be active at once, so the signing key can be rotated without signing anyone out.
 */
public final class JwtCodec {
    public static final class InvalidToken extends RuntimeException { public InvalidToken(String m) { super(m); } }

    /** The key the server signs with now, and every key it still accepts. */
    public record Keys(String currentKid, PrivateKey signingKey, Map<String, PublicKey> verificationKeys) {
        public Keys { verificationKeys = Map.copyOf(verificationKeys); }
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder D64 = Base64.getUrlDecoder();
    private static final long SKEW_SECONDS = 30;
    private static final Set<String> REQUIRED = Set.of("iss", "aud", "sub", "exp", "iat", "jti");

    private final Keys keys; private final String issuer; private final String audience; private final Clock clock;

    public JwtCodec(Keys keys, String issuer, String audience, Clock clock) { this.keys = keys; this.issuer = issuer; this.audience = audience; this.clock = clock; }

    public String sign(Map<String, Object> claims) {
        Map<String, Object> header = new LinkedHashMap<>();
        header.put("alg", "ES256"); header.put("typ", "JWT"); header.put("kid", keys.currentKid());
        Map<String, Object> body = new LinkedHashMap<>(claims);
        body.put("iss", issuer); body.put("aud", audience);
        String signingInput = b64json(header) + "." + b64json(body);
        try {
            Signature s = Signature.getInstance("SHA256withECDSAinP1363Format");    // raw R||S, as JWS requires (not DER)
            s.initSign(keys.signingKey()); s.update(signingInput.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            return signingInput + "." + B64.encodeToString(s.sign());
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    /** The claims of a valid token; InvalidToken otherwise (the reason is for logs, never for the client). */
    public Map<String, Object> verify(String token) {
        if (token == null || token.length() > 4096) throw new InvalidToken("missing or oversized");
        String[] parts = token.split("\\.", -1);
        if (parts.length != 3) throw new InvalidToken("not a compact JWS");
        Map<String, Object> header = parse(parts[0]);
        if (!"ES256".equals(header.get("alg"))) throw new InvalidToken("algorithm not allowed: " + header.get("alg"));
        if (header.containsKey("crit") || header.containsKey("jku") || header.containsKey("jwk") || header.containsKey("x5u")) throw new InvalidToken("header not allowed");
        PublicKey key = keys.verificationKeys().get(String.valueOf(header.get("kid")));
        if (key == null) throw new InvalidToken("unknown key id");
        try {
            Signature s = Signature.getInstance("SHA256withECDSAinP1363Format");
            s.initVerify(key); s.update((parts[0] + "." + parts[1]).getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            if (!s.verify(D64.decode(parts[2]))) throw new InvalidToken("bad signature");
        } catch (GeneralSecurityException | IllegalArgumentException e) { throw new InvalidToken("bad signature"); }
        Map<String, Object> claims = parse(parts[1]);
        for (String c : REQUIRED) if (!claims.containsKey(c)) throw new InvalidToken("missing claim " + c);
        if (!issuer.equals(claims.get("iss"))) throw new InvalidToken("wrong issuer");
        if (!audience.equals(claims.get("aud"))) throw new InvalidToken("wrong audience");
        long now = clock.instant().getEpochSecond();
        if (number(claims, "exp") + SKEW_SECONDS < now) throw new InvalidToken("expired");
        if (claims.containsKey("nbf") && number(claims, "nbf") - SKEW_SECONDS > now) throw new InvalidToken("not yet valid");
        if (number(claims, "iat") - SKEW_SECONDS > now) throw new InvalidToken("issued in the future");
        return claims;
    }

    public static Instant instant(Map<String, Object> claims, String name) { return Instant.ofEpochSecond(number(claims, name)); }

    private static long number(Map<String, Object> claims, String name) {
        if (claims.get(name) instanceof Number n) return n.longValue();
        throw new InvalidToken("claim " + name + " is not a number");
    }
    private static String b64json(Map<String, Object> m) {
        try { return B64.encodeToString(JSON.writeValueAsBytes(m)); } catch (Exception e) { throw new IllegalStateException(e); }
    }
    private static Map<String, Object> parse(String part) {
        try { return JSON.readValue(D64.decode(part), new TypeReference<Map<String, Object>>() {}); }
        catch (Exception e) { throw new InvalidToken("unreadable"); }
    }
}
