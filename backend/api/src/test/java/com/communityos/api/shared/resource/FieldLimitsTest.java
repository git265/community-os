package com.communityos.api.shared.resource;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.shared.domain.DomainException;
import java.math.BigDecimal;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The size floor under every register's fields. */
class FieldLimitsTest {
    record Thing(String name, String notes, String imageUrl, List<String> tags, Map<String, Object> extras, BigDecimal amount) {}
    static Thing ok() { return new Thing("Pump", "x".repeat(15_000), "data:image/png;base64," + "A".repeat(2_000_000), List.of("a", "b"), Map.of("k", "v"), new BigDecimal("12.50")); }
    @Test void limits() {
        FieldLimits.check(ok());
        assertEquals("too-large", assertThrows(DomainException.RuleViolated.class, () -> FieldLimits.check(new Thing("x".repeat(1_001), null, null, null, null, null))).code(), "a name");
        assertThrows(DomainException.RuleViolated.class, () -> FieldLimits.check(new Thing("n", "x".repeat(20_001), null, null, null, null)), "a note");
        assertThrows(DomainException.RuleViolated.class, () -> FieldLimits.check(new Thing("n", null, null, Collections.nCopies(1_001, "a"), null, null)), "a list");
        assertThrows(DomainException.RuleViolated.class, () -> FieldLimits.check(new Thing("n", null, null, List.of("y".repeat(2_001)), null, null)), "a list item");
        assertThrows(DomainException.RuleViolated.class, () -> FieldLimits.check(new Thing("n", null, null, null, Map.of("k", "z".repeat(2_001)), null)), "a value inside an object");
        assertThrows(DomainException.RuleViolated.class, () -> FieldLimits.check(new Thing("n", null, null, null, null, new BigDecimal("1e13"))), "a number");
        assertThrows(DomainException.RuleViolated.class, () -> FieldLimits.check(new Thing("n", null, null, null, null, new BigDecimal("1.1234567"))), "too many decimals");
    }
    @Test void requiredTextKeepsItsOwnSize() {
        assertEquals(600, Checks.required("b".repeat(600), "Body").length(), "a required body is not cut at 500 (its own limit, or the floor, applies)");
        assertEquals("required", assertThrows(DomainException.RuleViolated.class, () -> Checks.required("  ", "Body")).code());
        assertEquals("too-long", assertThrows(DomainException.RuleViolated.class, () -> Checks.text(Checks.required("n".repeat(201), "Name"), "Name", 200)).code());
    }
    @Test void fieldErrorsInPlainWords() {
        assertEquals("Preferred time", com.communityos.api.shared.web.ProblemHandler.fieldLabel("preferredTime"));
        assertEquals("Name", com.communityos.api.shared.web.ProblemHandler.fieldLabel("people[2].name"));
    }
}
