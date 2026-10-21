package com.communityos.api.config;

import com.communityos.api.shared.security.JwtCodec;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Loads the ES256 signing key (PKCS#8 PEM, from the secret manager via the environment) and the public keys still accepted. The public key of
 * the current private key is derived, so only one secret is configured. Without a key, development may generate a throw-away one; prod refuses.
 *   openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt      -> cos.auth.signing-key-pem
 */
final class SigningKeys {
    private static final Logger log = LoggerFactory.getLogger(SigningKeys.class);
    private SigningKeys() {}

    static JwtCodec.Keys load(CosProperties.Auth a, boolean prod) {
        try {
            Map<String, PublicKey> verify = new LinkedHashMap<>();
            if (a.previousKeys() != null) for (Map.Entry<String, String> e : a.previousKeys().entrySet())
                verify.put(e.getKey(), KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der(e.getValue()))));
            if (a.signingKeyPem() == null || a.signingKeyPem().isBlank()) {
                if (prod || !a.allowEphemeralKey()) throw new IllegalStateException("cos.auth.signing-key-pem is required");
                log.warn("no signing key configured: using a throw-away key (tokens stop working on restart) - development only");
                KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
                g.initialize(new ECGenParameterSpec("secp256r1"));
                KeyPair kp = g.generateKeyPair();
                verify.put(a.keyId(), kp.getPublic());
                return new JwtCodec.Keys(a.keyId(), kp.getPrivate(), verify);
            }
            ECPrivateKey priv = (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der(a.signingKeyPem())));
            verify.put(a.keyId(), publicOf(priv));
            return new JwtCodec.Keys(a.keyId(), priv, verify);
        } catch (java.security.GeneralSecurityException e) { throw new IllegalStateException("bad signing key", e); }
    }

    static byte[] der(String pem) { return Base64.getMimeDecoder().decode(pem.replaceAll("-----[A-Z ]+-----", "").replaceAll("\\s", "")); }

    /** Q = d x G on P-256, computed with BigInteger arithmetic (the JDK has no public API to derive it). */
    static ECPublicKey publicOf(ECPrivateKey priv) throws java.security.GeneralSecurityException {
        java.security.spec.ECParameterSpec spec = priv.getParams();
        java.security.spec.ECPoint q = multiply(spec.getGenerator(), priv.getS(), spec.getCurve(), ((java.security.spec.ECFieldFp) spec.getCurve().getField()).getP());
        return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new java.security.spec.ECPublicKeySpec(q, spec));
    }
    private static java.security.spec.ECPoint multiply(java.security.spec.ECPoint g, java.math.BigInteger k, java.security.spec.EllipticCurve curve, java.math.BigInteger p) {
        java.security.spec.ECPoint r = java.security.spec.ECPoint.POINT_INFINITY, a = g;
        for (int i = 0; i < k.bitLength(); i++) { if (k.testBit(i)) r = add(r, a, curve, p); a = add(a, a, curve, p); }
        return r;
    }
    private static java.security.spec.ECPoint add(java.security.spec.ECPoint s, java.security.spec.ECPoint t, java.security.spec.EllipticCurve curve, java.math.BigInteger p) {
        if (s.equals(java.security.spec.ECPoint.POINT_INFINITY)) return t;
        if (t.equals(java.security.spec.ECPoint.POINT_INFINITY)) return s;
        java.math.BigInteger x1 = s.getAffineX(), y1 = s.getAffineY(), x2 = t.getAffineX(), y2 = t.getAffineY(), l;
        if (x1.equals(x2)) {
            if (!y1.equals(y2) || y1.signum() == 0) return java.security.spec.ECPoint.POINT_INFINITY;
            l = x1.pow(2).multiply(java.math.BigInteger.valueOf(3)).add(curve.getA()).multiply(y1.shiftLeft(1).modInverse(p)).mod(p);
        } else l = y2.subtract(y1).multiply(x2.subtract(x1).modInverse(p)).mod(p);
        java.math.BigInteger x3 = l.pow(2).subtract(x1).subtract(x2).mod(p);
        return new java.security.spec.ECPoint(x3, l.multiply(x1.subtract(x3)).subtract(y1).mod(p));
    }
}
