package com.communityos.jobs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.communityos.adapter.gst.SimulatedGstProvider;
import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.service.Tx;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The job runner: every job for every community, in order; a job another server holds is skipped; one that fails does not stop the others. */
class JobRunnerTest {
    final ObjectMapper json = new ObjectMapper();
    final Clock clock = Clock.fixed(Instant.parse("2026-10-19T12:00:00Z"), ZoneOffset.UTC);

    private JobRunner runner(DocumentRepository repo, JobRunner.JobLock lock) {
        return new JobRunner(repo, new AuditTrail(repo, json, clock), json, clock, Constants.load(json), Tx.none(), 300, new SimulatedGstProvider(), null, lock);
    }

    @Test
    void everyJobRunsForEveryCommunityAndALockedOneIsSkipped() throws Exception {
        DocumentRepository repo = new InMemoryDocumentRepository();
        repo.upsert("a", "recurringBills", "r1", json.readTree("{\"id\":\"r1\",\"description\":\"AMC\",\"amount\":5000,\"dayOfMonth\":10}"));
        repo.upsert("b", "users", "u1", json.readTree("{\"id\":\"u1\",\"name\":\"X\"}"));
        repo.upsert("platform", "communities", "a", json.readTree("{\"id\":\"a\"}"));
        Map<String, Map<String, String>> r = runner(repo, (t, job) -> !(t.equals("b") && job.equals("late fees"))).runOnce();
        assertEquals(java.util.Set.of("a", "b"), r.keySet(), "the platform is not a community");
        assertEquals(java.util.List.of("utility types", "amenity scheduler", "recurring bills", "late fees", "due reminders", "ballot reminders", "input tax credit", "report schedules"), java.util.List.copyOf(r.get("a").keySet()));
        assertTrue(r.get("a").values().stream().allMatch("ok"::equals), r.toString());
        assertEquals("skipped (another server is running it)", r.get("b").get("late fees"));
        assertEquals(1, repo.list("a", "assocBills").size(), "the recurring bill was raised");
        assertEquals(2, repo.list("b", "utilityTypes").size(), "Water and DG were added");
        runner(repo, null).runOnce();
        assertEquals(1, repo.list("a", "assocBills").size(), "a second run changes nothing");
    }

    @Test
    void aFailingJobIsReportedAndTheOthersStillRun() throws Exception {
        DocumentRepository repo = new InMemoryDocumentRepository();
        repo.upsert("a", "financeSettings", "fs", json.readTree("{\"id\":\"fs\",\"lateFeeEnabled\":true,\"lateFeeAuto\":true,\"lateFeeRules\":\"[null]\"}"));
        Map<String, String> r = runner(repo, null).runOnce().get("a");
        assertTrue(r.get("late fees").startsWith("failed: "), r.toString());
        assertEquals("ok", r.get("report schedules"));
    }
}
