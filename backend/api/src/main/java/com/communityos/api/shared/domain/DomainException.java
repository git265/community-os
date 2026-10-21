package com.communityos.api.shared.domain;

/** A business rule said no. Mapped to HTTP 422 (rule), 404 (not found), 409 (conflict) by the web layer. */
public class DomainException extends RuntimeException {
    private final String code;
    public DomainException(String code, String message) { super(message); this.code = code; }
    public String code() { return code; }

    public static final class NotFound extends DomainException { public NotFound(String what) { super("not-found", what + " not found"); } }
    /** Someone else saved first (optimistic locking): reload and try again. */
    public static final class Conflict extends DomainException { public Conflict(String what) { super("conflict", what + " was changed by someone else - reload and try again"); } }
    public static final class RuleViolated extends DomainException { public RuleViolated(String code, String message) { super(code, message); } }
}
