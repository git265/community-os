package com.communityos.api.site.domain;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * A device's admin password at rest: AES-256-GCM with the community's own device key (32 random bytes made by the database, never sent to
 * the app). The stored form is the 12-byte nonce followed by the ciphertext and tag. The device's id is bound in as associated data, so a
 * password copied onto another device's row does not decrypt.
 */
public final class DeviceSecrets {
    private DeviceSecrets() {}
    private static final SecureRandom RANDOM = new SecureRandom();

    public static byte[] seal(byte[] key, java.util.UUID deviceId, String password) {
        try {
            byte[] nonce = new byte[12]; RANDOM.nextBytes(nonce);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
            c.updateAAD(deviceId.toString().getBytes(StandardCharsets.US_ASCII));
            byte[] ct = c.doFinal(password.getBytes(StandardCharsets.UTF_8));
            return ByteBuffer.allocate(nonce.length + ct.length).put(nonce).put(ct).array();
        } catch (GeneralSecurityException e) { throw new IllegalStateException("could not seal the device password", e); }
    }
    public static String open(byte[] key, java.util.UUID deviceId, byte[] sealed) {
        if (sealed == null || sealed.length < 13) return null;
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, sealed, 0, 12));
            c.updateAAD(deviceId.toString().getBytes(StandardCharsets.US_ASCII));
            return new String(c.doFinal(sealed, 12, sealed.length - 12), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException e) { throw new IllegalStateException("the stored device password does not open with this community's key", e); }
    }
}
