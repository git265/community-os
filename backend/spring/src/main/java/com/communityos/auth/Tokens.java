package com.communityos.auth;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The access tokens of local sign-in: HS256 JSON Web Tokens with iss, iat and exp. signJwt / verifyJwt of backend/contract-server/auth.mjs (local provider),
 * so a token issued by one server is accepted by the other when they share JWT_SECRET. Nothing in a token is believed before its signature is checked;
 * `alg: none` and any other algorithm are refused.
 */
public final class Tokens {
    private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder D64 = Base64.getUrlDecoder();
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};
    private final byte[] secret;
    private final String issuer;
    private final Clock clock;
    private final ObjectMapper json;

    public Tokens(String secret, String issuer, Clock clock, ObjectMapper json) {
        if (secret == null || secret.length() < 32) throw new IllegalStateException("app.auth.jwt-secret (env JWT_SECRET) must be set, at least 32 characters, for app.security.mode=local.");
        this.secret = secret.getBytes(StandardCharsets.UTF_8); this.issuer = issuer; this.clock = clock; this.json = json;
    }

    private long now() { return clock.millis() / 1000; }

    private byte[] mac(String data) {
        try { Mac m = Mac.getInstance("HmacSHA256"); m.init(new SecretKeySpec(secret, "HmacSHA256")); return m.doFinal(data.getBytes(StandardCharsets.UTF_8)); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }

    public String sign(Map<String, Object> claims, long ttlSeconds) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("iss", issuer); body.put("iat", now()); body.put("exp", now() + ttlSeconds);
        body.putAll(claims);
        try {
            String data = B64.encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8)) + "." + B64.encodeToString(json.writeValueAsBytes(body));
            return data + "." + B64.encodeToString(mac(data));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException(e); }
    }

    /** @return the claims of a valid, unexpired token from this issuer */
    public Map<String, Object> verify(String token) {
        String[] p = token == null ? new String[0] : token.split("\\.", -1);
        if (p.length != 3 || p[0].isEmpty() || p[1].isEmpty() || p[2].isEmpty()) throw new AuthException(401, "Sign in again.");
        Map<String, Object> head, claims;
        try { head = json.readValue(D64.decode(p[0]), MAP); claims = json.readValue(D64.decode(p[1]), MAP); } catch (Exception e) { throw new AuthException(401, "Sign in again."); }
        if (!"HS256".equals(head.get("alg"))) throw new AuthException(401, "Sign in again.");   // rejects alg:none and algorithm-confusion tokens
        byte[] given;
        try { given = D64.decode(p[2]); } catch (IllegalArgumentException e) { throw new AuthException(401, "Sign in again."); }
        if (!MessageDigest.isEqual(mac(p[0] + "." + p[1]), given)) throw new AuthException(401, "Sign in again.");
        if (!issuer.equals(claims.get("iss"))) throw new AuthException(401, "Sign in again.");
        Object exp = claims.get("exp");
        if (!(exp instanceof Number n) || n.longValue() < now()) throw new AuthException(401, "Your session has expired.", "expired");
        return claims;
    }
}
