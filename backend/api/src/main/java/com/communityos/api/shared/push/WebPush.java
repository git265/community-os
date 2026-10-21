package com.communityos.api.shared.push;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Web Push with no library, from the JDK alone:
 *   RFC 8291  message encryption (ECDH P-256 with the browser's key, HKDF-SHA256, AES-128-GCM, the aes128gcm content coding of RFC 8188)
 *   RFC 8292  VAPID: the server proves who it is to the push service with an ES256-signed token and its public key
 * The browser's push service (Google, Mozilla, Apple, Microsoft) only ever sees ciphertext.
 */
public final class WebPush {
    private WebPush() {}
    public static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    public static final Base64.Decoder D64 = Base64.getUrlDecoder();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int RECORD_SIZE = 4096;

    /** The server's VAPID key pair. The public key (65-byte point, base64url) is what the browser subscribes with. */
    public record Vapid(ECPublicKey publicKey, ECPrivateKey privateKey) {
        public String publicKeyB64() { return B64.encodeToString(raw(publicKey)); }
        public String privateKeyB64() { return B64.encodeToString(unsigned32(privateKey.getS())); }
    }

    public static Vapid generate() {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("EC"); g.initialize(new ECGenParameterSpec("secp256r1"));
            KeyPair kp = g.generateKeyPair();
            return new Vapid((ECPublicKey) kp.getPublic(), (ECPrivateKey) kp.getPrivate());
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }
    /** From the two base64url strings in the configuration (public: 65-byte point; private: 32-byte scalar). */
    public static Vapid of(String publicKeyB64, String privateKeyB64) {
        try {
            ECPublicKey pub = publicKey(D64.decode(publicKeyB64));
            ECPrivateKey priv = (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(new BigInteger(1, D64.decode(privateKeyB64)), params()));
            return new Vapid(pub, priv);
        } catch (GeneralSecurityException | IllegalArgumentException e) { throw new IllegalStateException("the VAPID keys are not valid P-256 keys (base64url)", e); }
    }

    /** The Authorization header for one push service: "vapid t=<ES256 JWT for its origin>, k=<public key>". */
    public static String vapidHeader(Vapid v, String endpoint, String subject, Instant now) {
        URI u = URI.create(endpoint);
        String aud = u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        String header = B64.encodeToString("{\"typ\":\"JWT\",\"alg\":\"ES256\"}".getBytes(StandardCharsets.UTF_8));
        String claims = B64.encodeToString(("{\"aud\":\"" + aud + "\",\"exp\":" + (now.getEpochSecond() + 12 * 3600) + ",\"sub\":\"" + subject.replace("\"", "") + "\"}").getBytes(StandardCharsets.UTF_8));
        String input = header + "." + claims;
        try {
            Signature s = Signature.getInstance("SHA256withECDSAinP1363Format");
            s.initSign(v.privateKey()); s.update(input.getBytes(StandardCharsets.US_ASCII));
            return "vapid t=" + input + "." + B64.encodeToString(s.sign()) + ", k=" + v.publicKeyB64();
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    /** The body of one push message: payload encrypted for the browser whose subscription has these keys (p256dh, auth). */
    public static byte[] encrypt(byte[] payload, String p256dhB64, String authB64) {
        if (payload.length > RECORD_SIZE - 17 - 1 - 16 - 86) throw new IllegalArgumentException("a push message holds at most about 3,900 bytes");
        try {
            byte[] uaPublic = D64.decode(p256dhB64), authSecret = D64.decode(authB64);
            if (uaPublic.length != 65 || uaPublic[0] != 4 || authSecret.length != 16) throw new IllegalArgumentException("not a Web Push subscription key");
            Vapid as = generate();                                   // a fresh key pair for this one message
            byte[] asPublic = raw(as.publicKey());
            KeyAgreement ka = KeyAgreement.getInstance("ECDH"); ka.init(as.privateKey()); ka.doPhase(publicKey(uaPublic), true);
            byte[] shared = ka.generateSecret();
            byte[] keyInfo = concat("WebPush: info\0".getBytes(StandardCharsets.US_ASCII), uaPublic, asPublic);
            byte[] ikm = hkdf(authSecret, shared, keyInfo, 32);
            byte[] salt = new byte[16]; RANDOM.nextBytes(salt);
            byte[] cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.US_ASCII), 16);
            byte[] nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0".getBytes(StandardCharsets.US_ASCII), 12);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
            byte[] ct = c.doFinal(concat(payload, new byte[] {2}));   // the last (only) record: delimiter 0x02, no padding
            ByteBuffer head = ByteBuffer.allocate(16 + 4 + 1 + 65);
            head.put(salt).putInt(RECORD_SIZE).put((byte) 65).put(asPublic);
            return concat(head.array(), ct);
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------------------------------------
    /** HKDF-SHA256 (RFC 5869) with one expand block (all lengths here are <= 32). */
    static byte[] hkdf(byte[] salt, byte[] ikm, byte[] info, int len) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        mac.update(info); mac.update((byte) 1);
        return Arrays.copyOf(mac.doFinal(), len);
    }
    static ECParameterSpec params() throws GeneralSecurityException {
        AlgorithmParameters p = AlgorithmParameters.getInstance("EC"); p.init(new ECGenParameterSpec("secp256r1"));
        return p.getParameterSpec(ECParameterSpec.class);
    }
    public static ECPublicKey publicKey(byte[] raw) throws GeneralSecurityException {
        if (raw.length != 65 || raw[0] != 4) throw new GeneralSecurityException("not an uncompressed P-256 point");
        ECPoint w = new ECPoint(new BigInteger(1, Arrays.copyOfRange(raw, 1, 33)), new BigInteger(1, Arrays.copyOfRange(raw, 33, 65)));
        return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(w, params()));
    }
    public static byte[] raw(ECPublicKey k) {
        return concat(new byte[] {4}, unsigned32(k.getW().getAffineX()), unsigned32(k.getW().getAffineY()));
    }
    static byte[] unsigned32(BigInteger n) {
        byte[] b = n.toByteArray();
        if (b.length == 32) return b;
        byte[] out = new byte[32];
        if (b.length > 32) System.arraycopy(b, b.length - 32, out, 0, 32); else System.arraycopy(b, 0, out, 32 - b.length, b.length);
        return out;
    }
    static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (byte[] p : parts) o.writeBytes(p);
        return o.toByteArray();
    }
}
