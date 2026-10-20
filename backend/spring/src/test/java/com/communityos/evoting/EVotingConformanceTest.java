package com.communityos.evoting;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class EVotingConformanceTest {
    @Test
    void theJavaVotingRulesAnswerLikeTheJavaScriptOnes() throws Exception {
        EVotingConformanceCheck check = new EVotingConformanceCheck();
        check.run();
        assertTrue(check.steps() > 50_000 && check.votes() > 400, "the golden corpus looks truncated: " + check.steps() + " steps, " + check.votes() + " votes");
        assertTrue(check.refused() > 10_000, "the corpus should refuse a lot");
        assertTrue(check.problems().isEmpty(), () -> check.problems().size() + " answers differ from the JavaScript, first ones:\n" + String.join("\n", check.problems().subList(0, Math.min(8, check.problems().size()))));
    }
}
