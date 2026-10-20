package com.communityos.web;

import com.fasterxml.jackson.databind.JsonNode;

/** Someone else saved this record after you loaded it (409). Carries the stored version so the screen can show what changed. */
public class ConflictException extends RuntimeException {
    private final transient JsonNode current;
    public ConflictException(JsonNode current) {
        super("This record was changed by someone else while you were editing. Reload it and apply your change again.");
        this.current = current;
    }
    /** A refusal that is a conflict of state rather than of versions (the bills are already paid): same 409, own words. */
    public ConflictException(String message, JsonNode current) {
        super(message);
        this.current = current;
    }
    public JsonNode current() { return current; }
}
