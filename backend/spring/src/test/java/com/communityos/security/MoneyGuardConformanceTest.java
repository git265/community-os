package com.communityos.security;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MoneyGuardConformanceTest {
    @Test
    void theJavaMoneyGuardAnswersEveryCaseTheJavaScriptOneDid() throws Exception {
        MoneyGuardConformanceCheck check = new MoneyGuardConformanceCheck();
        check.run();
        assertTrue(check.checked() > 100_000, "the golden corpus should hold more than 100,000 cases, it has " + check.checked());
        assertTrue(check.refused() > 10_000, "the corpus should refuse a good share of them, it refuses " + check.refused());
        assertTrue(check.problems().isEmpty(), () -> "the Java money guard differs from the JavaScript one:\n" + String.join("\n", check.problems().subList(0, Math.min(10, check.problems().size()))));
    }
}
