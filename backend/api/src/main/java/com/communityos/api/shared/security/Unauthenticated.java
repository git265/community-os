package com.communityos.api.shared.security;

/** Sign-in failed (HTTP 401). One message for every reason, so a caller cannot tell a wrong code from an unknown number or an expired code. */
public final class Unauthenticated extends RuntimeException {
    public Unauthenticated() { super("The code is wrong or has expired"); }
    public Unauthenticated(String message) { super(message); }
}
