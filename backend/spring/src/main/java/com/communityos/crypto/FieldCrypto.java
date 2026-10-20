package com.communityos.crypto;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Field-level encryption at rest (AES-256-GCM) for personal numbers such as ID and bank account numbers: a port of backend/contract-server/fieldcrypto.mjs, and
 * it reads and writes the SAME format, so a database written by the Node reference can be read by Spring and the other way round.
 * <p>
 * Stored as {@code enc:v1:<keyid>:<iv>:<tag>:<ciphertext>} (base64 parts; the key id is the first 8 hex characters of SHA-256 of the key). Values written
 * before a key was set stay readable. Rotation: put the new key in DATA_ENCRYPTION_KEY and the older ones, comma separated, in DATA_ENCRYPTION_KEY_OLD.
 * A protected field cannot be searched or sorted on. This is in addition to, not instead of, database / disk encryption and TLS.
 */
public final class FieldCrypto {
    public static final Set<String> DEFAULT_FIELDS = Set.of("aadhaar", "panNumber", "accountNumber", "ssn", "passportNumber", "taxId");
    private static final JsonNodeFactory F = JsonNodeFactory.instance;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final ObjectMapper json;
    private final byte[] current;
    private final Map<String, byte[]> keys = new HashMap<>();
    private final Set<String> fields;

    /** @param key  DATA_ENCRYPTION_KEY: 32 bytes as 64 hex characters or base64; null or blank = encryption off
     *  @param old  DATA_ENCRYPTION_KEY_OLD: older keys, comma separated
     *  @param fieldList ENCRYPT_FIELDS: comma separated field names (blank = the default list) */
    public FieldCrypto(ObjectMapper json, String key, String old, String fieldList) {
        this.json = json;
        this.current = key == null || key.isBlank() ? null : asKey(key.trim());
        if (current != null) keys.put(kid(current), current);
        if (old != null) for (String s : old.split(",")) if (!s.trim().isEmpty()) { byte[] k = asKey(s.trim()); keys.put(kid(k), k); }
        Set<String> f = new LinkedHashSet<>();
        if (current != null) {
            if (fieldList == null || fieldList.isBlank()) f.addAll(DEFAULT_FIELDS); else for (String s : fieldList.split(",")) if (!s.trim().isEmpty()) f.add(s.trim());
        }
        this.fields = Set.copyOf(f);
    }

    public static FieldCrypto off(ObjectMapper json) { return new FieldCrypto(json, null, null, null); }

    public boolean enabled() { return current != null && !fields.isEmpty(); }
    public Set<String> fields() { return fields; }
    public static boolean isEnc(JsonNode v) { return v != null && v.isTextual() && v.asText().startsWith("enc:v1:"); }

    private static byte[] asKey(String s) {
        byte[] b = s.matches("(?i)[0-9a-f]{64}") ? HexFormat.of().parseHex(s) : Base64.getDecoder().decode(s);
        if (b.length != 32) throw new IllegalStateException("DATA_ENCRYPTION_KEY must be 32 bytes (64 hex characters).");
        return b;
    }
    private static String kid(byte[] key) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(key)).substring(0, 8); } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    private String enc(JsonNode v) {
        try {
            byte[] iv = new byte[12]; RANDOM.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(current, "AES"), new GCMParameterSpec(128, iv));
            byte[] out = c.doFinal(Js.stringify(v).getBytes(StandardCharsets.UTF_8));   // ciphertext || 16-byte tag
            byte[] ct = Arrays.copyOfRange(out, 0, out.length - 16), tag = Arrays.copyOfRange(out, out.length - 16, out.length);
            Base64.Encoder b = Base64.getEncoder();
            return "enc:v1:" + kid(current) + ":" + b.encodeToString(iv) + ":" + b.encodeToString(tag) + ":" + b.encodeToString(ct);
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    private JsonNode dec(String s) {
        String[] p = s.split(":", -1);
        byte[] key = p.length > 2 ? keys.get(p[2]) : null;
        if (key == null) throw new IllegalStateException("No key for this encrypted value.");
        try {
            byte[] iv = Base64.getDecoder().decode(p[3]), tag = Base64.getDecoder().decode(p[4]), ct = Base64.getDecoder().decode(p[5]);
            byte[] in = new byte[ct.length + tag.length];
            System.arraycopy(ct, 0, in, 0, ct.length); System.arraycopy(tag, 0, in, ct.length, tag.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            return json.readTree(new String(c.doFinal(in), StandardCharsets.UTF_8));
        } catch (GeneralSecurityException | java.io.IOException | RuntimeException e) { throw new IllegalStateException("Encrypted value is damaged or was not written with this key.", e); }
    }

    private interface Leaf { JsonNode apply(String key, JsonNode value); }

    /** Walk a record: objects keep their keys, arrays their items; {@code f} may replace the value of an object entry (null = keep walking inside it). */
    private static JsonNode walk(JsonNode o, Leaf f) {
        if (o.isArray()) { ArrayNode a = F.arrayNode(); for (JsonNode x : o) a.add(walk(x, f)); return a; }
        if (o.isObject()) {
            ObjectNode r = F.objectNode();
            o.fields().forEachRemaining(e -> { JsonNode v = f.apply(e.getKey(), e.getValue()); r.set(e.getKey(), v != null ? v : walk(e.getValue(), f)); });
            return r;
        }
        return o;
    }

    /** The record as it is stored: every protected field (anywhere in it) that holds a plain text, number or flag is encrypted. */
    public JsonNode encryptRecord(JsonNode rec) {
        if (!enabled() || rec == null) return rec;
        return walk(rec, (k, v) -> fields.contains(k) && !(v.isTextual() && v.asText().isEmpty()) && !v.isNull() && !v.isMissingNode() && !isEnc(v) && !v.isContainerNode() ? F.textNode(enc(v)) : null);
    }

    /** The record as callers see it: every encrypted value is opened (a damaged one throws). */
    public JsonNode decryptRecord(JsonNode rec) {
        if (rec == null) return null;
        return walk(rec, (k, v) -> isEnc(v) ? dec(v.asText()) : null);
    }
}
