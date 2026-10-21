package com.communityos.api.shared.resilience;

import java.io.IOException;
import java.net.http.HttpTimeoutException;
import java.util.concurrent.TimeoutException;

/** A failure worth retrying: the other side may succeed next time. */
public class TransientFailure extends RuntimeException {
    public TransientFailure(String message, Throwable cause) { super(message, cause); }
    public TransientFailure(String message) { super(message); }

    public static boolean is(Throwable t) {
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof TransientFailure || c instanceof TimeoutException || c instanceof HttpTimeoutException || c instanceof IOException) return true;
            if (c instanceof CircuitBreaker.OpenException) return false;
        }
        return false;
    }
}
