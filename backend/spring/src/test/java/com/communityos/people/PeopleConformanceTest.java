package com.communityos.people;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PeopleConformanceTest {
    @Test
    void phonesPropertiesAndMeetingsAreCheckedAndAnnouncedAsTheJavaScriptDoes() throws Exception {
        PeopleConformanceCheck check = new PeopleConformanceCheck();
        check.run();
        assertTrue(check.ops() > 30_000, "the golden corpus looks truncated: " + check.ops() + " operations");
        var seen = check.seen();
        assertTrue(seen.getOrDefault("validPhones", 0) > 2_000 && seen.getOrDefault("refusedPhones", 0) > 10_000 && seen.getOrDefault("acceptedProperties", 0) > 150
                && seen.getOrDefault("rows:users", 0) > 300 && seen.getOrDefault("rows:portalInvites", 0) > 300 && seen.getOrDefault("meetingMessages", 0) > 300, "the corpus should exercise every rule: " + seen);
        assertTrue(check.problems().isEmpty(), () -> check.problems().size() + " answers differ from the JavaScript, first ones:\n" + String.join("\n", check.problems().subList(0, Math.min(6, check.problems().size()))));
    }
}
