package com.communityos.web;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/**
 * One JSON error shape for the whole API: { "message": "..." } - the UI shows `message` as is.
 * Extends ResponseEntityExceptionHandler so Spring's own errors (missing X-Community-Id header, unreadable JSON, wrong method,
 * unsupported media type) keep their proper 4xx status instead of turning into 500.
 */
@RestControllerAdvice
public class ApiExceptionHandler extends ResponseEntityExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(BadRequestException.class)
    ResponseEntity<Object> bad(BadRequestException e) { return body(HttpStatus.BAD_REQUEST, e.getMessage()); }

    @ExceptionHandler(NotFoundException.class)
    ResponseEntity<Object> missing(NotFoundException e) { return body(HttpStatus.NOT_FOUND, e.getMessage()); }

    @ExceptionHandler(AccessDeniedException.class)
    ResponseEntity<Object> denied(AccessDeniedException e) { return body(HttpStatus.FORBIDDEN, e.getMessage(), "denied", null); }

    /** Someone else saved first: 409 with the stored version, so the screen can show what changed. */
    @ExceptionHandler(ConflictException.class)
    ResponseEntity<Object> conflict(ConflictException e) { return body(HttpStatus.CONFLICT, e.getMessage(), "conflict", e.current()); }

    /** A provider event whose signature does not match: nothing was read from it. */
    @ExceptionHandler(com.communityos.service.PaymentService.WebhookSignatureException.class)
    ResponseEntity<Object> badSignature(RuntimeException e) { return body(HttpStatus.UNAUTHORIZED, e.getMessage()); }

    /** The payment provider is slow or down: answer quickly, the screen can retry. */
    @ExceptionHandler({com.communityos.payments.CircuitBreaker.OpenException.class, com.communityos.payments.CircuitBreaker.TimedOutException.class})
    ResponseEntity<Object> providerDown(RuntimeException e) { return body(HttpStatus.SERVICE_UNAVAILABLE, e.getMessage(), "provider-unavailable", null); }

    /** Sign-in refusals keep their status (401 / 403 / 404 / 429 ...) and code ("expired", "locked", "deactivated"): the screen acts on them. */
    @ExceptionHandler(com.communityos.auth.AuthException.class)
    ResponseEntity<Object> auth(com.communityos.auth.AuthException e) { return body(HttpStatus.valueOf(e.status()), e.getMessage(), e.code(), null); }

    @ExceptionHandler(UnsupportedOperationException.class)
    ResponseEntity<Object> unsupported(UnsupportedOperationException e) { return body(HttpStatus.BAD_REQUEST, e.getMessage()); }

    @ExceptionHandler(Exception.class)
    ResponseEntity<Object> other(Exception e) {
        log.error("Unhandled error", e);
        return body(HttpStatus.INTERNAL_SERVER_ERROR, "Server error.");
    }

    /** Every framework-generated error (400/404/405/415 ...) comes through here. */
    @Override
    protected ResponseEntity<Object> handleExceptionInternal(Exception ex, Object body, HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        String message = status.value() == 400 ? friendly400(ex) : HttpStatus.valueOf(status.value()).getReasonPhrase();
        return ResponseEntity.status(status).headers(headers).body(Map.of("message", message));
    }

    private static String friendly400(Exception ex) {
        String m = ex.getMessage() == null ? "" : ex.getMessage();
        if (m.contains("X-Community-Id")) return "Send a valid X-Community-Id header.";
        if (ex instanceof org.springframework.http.converter.HttpMessageNotReadableException) return "The request body is not valid JSON.";
        return "Bad request.";
    }

    private static ResponseEntity<Object> body(HttpStatus s, String m) { return body(s, m, null, null); }

    private static ResponseEntity<Object> body(HttpStatus s, String m, String code, Object current) {
        String rid = org.slf4j.MDC.get("requestId");   // lets support find the log lines of this call
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("message", m == null ? s.getReasonPhrase() : m);
        if (code != null) out.put("code", code);
        if (current != null) out.put("current", current);
        if (rid != null) out.put("requestId", rid);
        return ResponseEntity.status(s).body(out);
    }
}
