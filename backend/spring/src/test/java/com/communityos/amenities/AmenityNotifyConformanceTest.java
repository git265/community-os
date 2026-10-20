package com.communityos.amenities;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class AmenityNotifyConformanceTest {
    @Test
    void theJavaMessagesReportsAndSchedulerDoWhatTheJavaScriptOnesDo() throws Exception {
        AmenityNotifyConformanceCheck check = new AmenityNotifyConformanceCheck();
        check.run();
        assertTrue(check.ops() > 10_000, "the golden corpus looks truncated: " + check.ops() + " operations");
        var seen = check.seen();
        assertTrue(seen.getOrDefault("rows:notificationOutbox", 0) > 5_000 && seen.getOrDefault("rows:notifications", 0) > 10_000, "the corpus should queue many messages: " + seen);
        assertTrue(seen.getOrDefault("released", 0) > 200 && seen.getOrDefault("completed", 0) > 150 && seen.getOrDefault("reminders", 0) > 50 && seen.getOrDefault("dailyReports", 0) > 50 && seen.getOrDefault("summaryReports", 0) > 30,
                "the corpus should exercise every scheduler step: " + seen);
        assertTrue(check.problems().isEmpty(), () -> check.problems().size() + " answers differ from the JavaScript, first ones:\n" + String.join("\n", check.problems().subList(0, Math.min(6, check.problems().size()))));
    }
}
