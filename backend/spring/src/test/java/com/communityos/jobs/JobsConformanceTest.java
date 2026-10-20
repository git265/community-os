package com.communityos.jobs;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class JobsConformanceTest {
    @Test
    void theJavaMessagesLateFeesRemindersAndJobsDoWhatTheJavaScriptOnesDo() throws Exception {
        JobsConformanceCheck check = new JobsConformanceCheck();
        check.run();
        assertTrue(check.ops() > 12_000, "the golden corpus looks truncated: " + check.ops() + " operations");
        var seen = check.seen();
        assertTrue(seen.getOrDefault("rows:notifications", 0) > 3_000 && seen.getOrDefault("rows:notificationOutbox", 0) > 1_000 && seen.getOrDefault("lateFeeRows", 0) > 500
                && seen.getOrDefault("reminders", 0) > 300 && seen.getOrDefault("reportsRun", 0) > 50 && seen.getOrDefault("recurringBills", 0) > 100, "the corpus should exercise every job: " + seen);
        assertTrue(check.problems().isEmpty(), () -> check.problems().size() + " answers differ from the JavaScript, first ones:\n" + String.join("\n", check.problems().subList(0, Math.min(6, check.problems().size()))));
    }
}
