package com.communityos.amenities;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class AmenityConformanceTest {
    @Test
    void theJavaBookingRulesDecideAndPostLikeTheJavaScriptOnes() throws Exception {
        AmenityConformanceCheck check = new AmenityConformanceCheck();
        check.run();
        assertTrue(check.decisions() > 15_000 && check.postings() > 2_000, "the golden corpus looks truncated: " + check.decisions() + " decisions, " + check.postings() + " postings");
        assertTrue(check.decisions() - check.refused() > 2_000, "the corpus should let a good share of bookings through");
        assertTrue(check.problems().isEmpty(), () -> check.problems().size() + " answers differ from the JavaScript, first ones:\n" + String.join("\n", check.problems().subList(0, Math.min(8, check.problems().size()))));
    }
}
