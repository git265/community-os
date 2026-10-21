package com.communityos.api.shared.security;

/** The caller may not do this. Mapped to HTTP 403 (or 404 when revealing the record's existence would itself leak, see NotVisible). */
public class AccessDenied extends RuntimeException {
    public AccessDenied(String message) { super(message); }
    /** The record exists but is outside the caller's scope: answered exactly like "not found". */
    public static final class NotVisible extends AccessDenied { public NotVisible() { super("Not found"); } }
}
