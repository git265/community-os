package com.communityos.security;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** The Java rule book must give the same answer, with the same wording, as the JavaScript one for every question in the golden corpus. */
class RuleBookConformanceTest {
    @Test
    void javaRulesMatchTheJavaScriptRuleBook() throws Exception {
        RuleBookConformanceCheck check = new RuleBookConformanceCheck();
        check.run();
        assertTrue(check.writes() > 50_000 && check.reads() > 3_000, "the corpus looks truncated");
        assertTrue(check.problems().isEmpty(), () -> check.problems().size() + " answers differ from the JS rule book, first ones:\n" + String.join("\n", check.problems().subList(0, Math.min(15, check.problems().size()))));
    }
}
