package com.communityos.security;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

/** One poll answer per villa, written to match pollPreWrite in src/lib/propertyServer.js. */
class PollRulesTest {
    final ObjectMapper json = new ObjectMapper();

    private JsonNode j(String s) throws Exception { return json.readTree(s); }
    private RawReader votes(String... rows) throws Exception {
        List<JsonNode> list = new java.util.ArrayList<>();
        for (String r : rows) list.add(j(r));
        return (c) -> list;
    }

    @Test
    void aSecondPersonFromTheSameVillaIsRefusedWithTheNameOfTheFirst() throws Exception {
        RawReader raw = votes("{\"id\":\"v1\",\"broadcastId\":\"b1\",\"unit\":\"A-101\",\"voter\":\"Asha\"}");
        assertEquals("A-101 has already voted on this poll (by Asha). There is one vote per villa.",
                PollRules.preWrite(j("{\"id\":\"v2\",\"broadcastId\":\"b1\",\"unit\":\"A-101\",\"voter\":\"Ravi\"}"), raw));
    }

    @Test
    void theSamePersonChangesTheirAnswerEvenIfCapitalsOrSpacesDiffer() throws Exception {
        RawReader raw = votes("{\"id\":\"v1\",\"broadcastId\":\"b1\",\"unit\":\"A-101\",\"voter\":\"Asha\"}");
        assertEquals("", PollRules.preWrite(j("{\"id\":\"v2\",\"broadcastId\":\"b1\",\"unit\":\"A-101\",\"voter\":\"  ASHA\\u00a0\"}"), raw));
        assertEquals("", PollRules.preWrite(j("{\"id\":\"v1\",\"broadcastId\":\"b1\",\"unit\":\"A-101\",\"voter\":\"Ravi\"}"), raw));   // editing the stored vote itself
    }

    @Test
    void anotherVillaAnotherPollOrNoUnitIsNotAffected() throws Exception {
        RawReader raw = votes("{\"id\":\"v1\",\"broadcastId\":\"b1\",\"unit\":\"A-101\",\"voter\":\"Asha\"}");
        assertEquals("", PollRules.preWrite(j("{\"id\":\"v2\",\"broadcastId\":\"b1\",\"unit\":\"B-202\",\"voter\":\"Ravi\"}"), raw));
        assertEquals("", PollRules.preWrite(j("{\"id\":\"v2\",\"broadcastId\":\"b2\",\"unit\":\"A-101\",\"voter\":\"Ravi\"}"), raw));
        assertEquals("", PollRules.preWrite(j("{\"id\":\"v2\",\"broadcastId\":\"b1\",\"voter\":\"Ravi\"}"), raw));
    }

    @Test
    void aStoredVoteWithNoVoterNameReadsUndefinedLikeTheJavaScript() throws Exception {
        RawReader raw = votes("{\"id\":\"v1\",\"broadcastId\":\"b1\",\"unit\":\"A-101\"}");
        assertEquals("A-101 has already voted on this poll (by undefined). There is one vote per villa.",
                PollRules.preWrite(j("{\"id\":\"v2\",\"broadcastId\":\"b1\",\"unit\":\"A-101\",\"voter\":\"Ravi\"}"), raw));
        assertEquals("", PollRules.preWrite(j("{\"id\":\"v2\",\"broadcastId\":\"b1\",\"unit\":\"A-101\"}"), raw));   // two nameless voters are "the same name"
    }
}
