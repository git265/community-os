package com.communityos.api.shared;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.shared.web.Truncation;
import org.junit.jupiter.api.Test;

/** A capped list that comes back full is reported; anything else is not. */
class TruncationTest {
    @Test void reportsAListThatReachedItsCap() {
        Truncation.check("SELECT 1 FROM t LIMIT 2000", 2000);
        assertEquals(0, Truncation.reached(), "outside a read request nothing is recorded");
        Truncation.begin();
        try {
            Truncation.check("SELECT 1 FROM t ORDER BY a LIMIT 2000", 1999); assertEquals(0, Truncation.reached(), "short of the cap");
            Truncation.check("SELECT 1 FROM t ORDER BY a LIMIT :limit OFFSET :offset", 50); assertEquals(0, Truncation.reached(), "a paged list has its own total");
            Truncation.check("SELECT s FROM settings LIMIT 1", 1); Truncation.check("SELECT t FROM late ORDER BY sla LIMIT 4", 4);
            assertEquals(0, Truncation.reached(), "a one-row look-up or a top-4 is not a cut list");
            Truncation.check("SELECT 1 FROM t\nORDER BY a, b\nLIMIT 500\n", 500); assertEquals(500, Truncation.reached(), "at the cap");
            Truncation.check("SELECT 1 FROM t LIMIT 2000", 2000); assertEquals(2000, Truncation.reached(), "the largest cap reached");
            Truncation.check("SELECT 1 FROM (SELECT 1 FROM x LIMIT 5) s WHERE true", 5); assertEquals(2000, Truncation.reached(), "only the statement's own, last LIMIT");
        } finally { Truncation.end(); }
        assertEquals(0, Truncation.reached());
    }
}
