package com.communityos.api.shared.web;

import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.BadSignature;
import com.communityos.api.shared.security.TooManyAttempts;
import com.communityos.api.shared.security.Unauthenticated;
import com.communityos.api.shared.resilience.CircuitBreaker;
import java.net.URI;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Every error as RFC 9457 problem+json with a stable `code` the apps switch on. Internals (SQL, stack traces, which rule matched) never reach
 * the client; a 500 carries only an error id that is also in the log.
 */
@RestControllerAdvice
public class ProblemHandler {
    private static final Logger log = LoggerFactory.getLogger(ProblemHandler.class);

    @ExceptionHandler(AccessDenied.NotVisible.class) public ProblemDetail notVisible(AccessDenied.NotVisible e) { return problem(HttpStatus.NOT_FOUND, "not-found", "Not found"); }
    @ExceptionHandler(AccessDenied.class) public ProblemDetail denied(AccessDenied e) {
        // refused access is a security event: counted, and logged with the request id (who it was is in the audit context, never the body)
        io.micrometer.core.instrument.Metrics.counter("cos.access.denied").increment();
        log.warn("access denied: {}", e.getMessage());
        return problem(HttpStatus.FORBIDDEN, "forbidden", e.getMessage());
    }
    @ExceptionHandler(Unauthenticated.class) public ProblemDetail unauthenticated(Unauthenticated e) { io.micrometer.core.instrument.Metrics.counter("cos.auth.refused").increment(); return problem(HttpStatus.UNAUTHORIZED, "unauthenticated", e.getMessage()); }
    @ExceptionHandler(BadSignature.class) public ProblemDetail badSignature(BadSignature e) { log.warn("bad signature refused"); io.micrometer.core.instrument.Metrics.counter("cos.webhooks.rejected").increment(); return problem(HttpStatus.UNAUTHORIZED, "bad-signature", "Signature does not match"); }
    @ExceptionHandler(TooManyAttempts.class) public ResponseEntity<ProblemDetail> tooMany(TooManyAttempts e) {
        io.micrometer.core.instrument.Metrics.counter("cos.rate_limited").increment();
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).header("Retry-After", String.valueOf(e.retryAfterSeconds()))
            .body(problem(HttpStatus.TOO_MANY_REQUESTS, "rate-limited", e.getMessage()));
    }
    @ExceptionHandler(DomainException.NotFound.class) public ProblemDetail notFound(DomainException e) { return problem(HttpStatus.NOT_FOUND, e.code(), e.getMessage()); }
    @ExceptionHandler(DomainException.Conflict.class) public ProblemDetail conflict(DomainException e) { return problem(HttpStatus.CONFLICT, e.code(), e.getMessage()); }
    @ExceptionHandler(DomainException.class) public ProblemDetail rule(DomainException e) {
        return problem(e.code().equals("precondition-required") ? HttpStatus.PRECONDITION_REQUIRED : HttpStatus.UNPROCESSABLE_ENTITY, e.code(), e.getMessage());
    }
    @ExceptionHandler(HttpMessageNotReadableException.class) public ProblemDetail unreadable(HttpMessageNotReadableException e) {
        for (Throwable t = e; t != null; t = t.getCause()) if (t instanceof RequestGuardFilter.PayloadTooLarge) return problem(HttpStatus.PAYLOAD_TOO_LARGE, "too-large", "The request is too large");
        return problem(HttpStatus.BAD_REQUEST, "bad-request", "The request body is not valid: unknown, misspelt or wrongly typed fields are refused");
    }
    @ExceptionHandler(MethodArgumentNotValidException.class) public ProblemDetail invalid(MethodArgumentNotValidException e) {
        ProblemDetail p = problem(HttpStatus.BAD_REQUEST, "validation", "Some fields are not valid");
        p.setProperty("fields", e.getBindingResult().getFieldErrors().stream().map((f) -> java.util.Map.of("field", f.getField(), "message", String.valueOf(f.getDefaultMessage()))).toList());
        return p;
    }
    @ExceptionHandler(DuplicateKeyException.class) public ProblemDetail duplicate(DuplicateKeyException e) { return problem(HttpStatus.CONFLICT, "duplicate", "That already exists"); }
    @ExceptionHandler(DataIntegrityViolationException.class) public ProblemDetail integrity(DataIntegrityViolationException e) {
        log.info("integrity refusal: {}", firstLine(e.getMostSpecificCause().getMessage()));   // the rule's name; the "Detail:" line with the values stays out of the log
        return problem(HttpStatus.UNPROCESSABLE_ENTITY, "integrity", "The change breaks a data rule and was not saved");
    }
    @ExceptionHandler(CircuitBreaker.OpenException.class) public ProblemDetail unavailable(CircuitBreaker.OpenException e) {
        return problem(HttpStatus.SERVICE_UNAVAILABLE, "provider-unavailable", e.getMessage());
    }
    /** An outside service (the payment provider ...) that did not answer, after the retries: try again later; nothing was done. */
    @ExceptionHandler(com.communityos.api.shared.resilience.TransientFailure.class) public ProblemDetail transientFailure(com.communityos.api.shared.resilience.TransientFailure e) {
        log.info("provider unavailable: {}", e.toString());
        ProblemDetail p = problem(HttpStatus.SERVICE_UNAVAILABLE, "provider-unavailable", e.getMessage() == null ? "A service we depend on is not answering - try again in a minute" : e.getMessage());
        p.setProperty("retryAfterSeconds", 60);
        return p;
    }
    /** Two people changing the same rows at once, or a statement past its time limit: nothing was saved; try again. */
    @ExceptionHandler({org.springframework.dao.PessimisticLockingFailureException.class, org.springframework.dao.QueryTimeoutException.class})
    public ResponseEntity<ProblemDetail> busy(org.springframework.dao.DataAccessException e) {
        log.info("busy: {}", e.getClass().getSimpleName());
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).header("Retry-After", "2").body(problem(HttpStatus.SERVICE_UNAVAILABLE, "busy", "The server is busy with the same records - try again"));
    }
    /** A path or query value of the wrong type (a bad id in the URL ...). */
    @ExceptionHandler(org.springframework.beans.TypeMismatchException.class) public ProblemDetail typeMismatch(org.springframework.beans.TypeMismatchException e) {
        return problem(HttpStatus.BAD_REQUEST, "bad-request", "A value in the address is not valid" + (e.getPropertyName() == null ? "" : ": " + e.getPropertyName()));
    }
    @ExceptionHandler(jakarta.validation.ConstraintViolationException.class) public ProblemDetail constraint(jakarta.validation.ConstraintViolationException e) {
        return problem(HttpStatus.BAD_REQUEST, "validation", "Some values are not valid");
    }
    @ExceptionHandler(Exception.class) public ProblemDetail unexpected(Exception e) {
        // the framework's own refusals (no such address, wrong method or content type, a missing or invalid parameter, a too large upload) keep their status
        if (e instanceof org.springframework.web.ErrorResponse er && er.getStatusCode().value() < 500) {
            int s = er.getStatusCode().value();
            HttpStatus st = HttpStatus.resolve(s) == null ? HttpStatus.BAD_REQUEST : HttpStatus.resolve(s);
            String code = switch (s) { case 404 -> "not-found"; case 405 -> "method-not-allowed"; case 406 -> "not-acceptable"; case 413 -> "too-large"; case 415 -> "unsupported-media-type"; default -> "bad-request"; };
            return problem(st, code, switch (s) { case 404 -> "Not found"; case 405 -> "That method is not allowed here"; case 413 -> "The request is too large"; case 415 -> "That content type is not accepted";
                default -> s == 400 ? "The request is not valid" : st.getReasonPhrase(); });
        }
        io.micrometer.core.instrument.Metrics.counter("cos.errors.unexpected").increment();
        String id = UUID.randomUUID().toString();
        log.error("unexpected error {}", id, e);
        ProblemDetail p = problem(HttpStatus.INTERNAL_SERVER_ERROR, "internal", "Something went wrong. Quote error id " + id + " to support.");
        p.setProperty("errorId", id);
        return p;
    }

    static String firstLine(String m) { if (m == null) return ""; int i = m.indexOf('\n'); return i < 0 ? m : m.substring(0, i); }
    static ProblemDetail problem(HttpStatus status, String code, String detail) {
        ProblemDetail p = ProblemDetail.forStatusAndDetail(status, detail);
        p.setType(URI.create("https://communityos.app/problems/" + code));
        p.setProperty("code", code);
        return p;
    }
}
