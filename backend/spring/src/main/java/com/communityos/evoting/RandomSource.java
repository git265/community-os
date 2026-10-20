package com.communityos.evoting;

/** Where the random bytes of codes, tokens and receipts come from. Production: SecureRandom. The conformance test plugs in the generator the JavaScript run used. */
public interface RandomSource {
    byte[] bytes(int n);

    default String hex(int n) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes(n)) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    /** One unsigned 32-bit number, read from four bytes least significant first (a Uint32Array on a little-endian machine). */
    default long uint32() {
        byte[] b = bytes(4);
        return (b[0] & 0xffL) | ((b[1] & 0xffL) << 8) | ((b[2] & 0xffL) << 16) | ((b[3] & 0xffL) << 24);
    }

    static RandomSource secure() {
        java.security.SecureRandom r = new java.security.SecureRandom();
        return (n) -> { byte[] b = new byte[n]; r.nextBytes(b); return b; };
    }
}
