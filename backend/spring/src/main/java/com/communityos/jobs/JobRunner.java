package com.communityos.jobs;

import com.communityos.access.CommunityMetaLoader;
import com.communityos.amenities.AmenityNotifier;
import com.communityos.amenities.AmenityScheduler;
import com.communityos.amenities.AmenitySystem;
import com.communityos.config.AppProperties;
import com.communityos.finance.ItcJob;
import com.communityos.finance.LateFees;
import com.communityos.finance.RecurringBills;
import com.communityos.finance.SystemWriter;
import com.communityos.finance.UtilityTypes;
import com.communityos.notify.DueReminders;
import com.communityos.notify.EventNotifications;
import com.communityos.notify.Notifier;
import com.communityos.port.DocumentRepository;
import com.communityos.port.GstProvider;
import com.communityos.reports.ReportSchedules;
import com.communityos.security.Constants;
import com.communityos.service.Tx;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The scheduled work that once ran inside whichever browser happened to be open, run on the server as in backend/contract-server/jobs.mjs:
 * utility types, the amenity scheduler, recurring bills, late fees, payment reminders, e-voting reminders, the GST input-credit check and the report schedules,
 * in that order, for one community at a time. Each job of each community is ONE transaction; one that fails is logged and the others still run.
 *
 * Several servers: a job of a community first takes a PostgreSQL transaction-level advisory lock on (727001, community + job). A second server that finds
 * it taken skips that job this time, so the same bill, fee or reminder is never made twice. Every job also re-reads what it needs and only does what is still
 * due, so a run that is late or repeated changes nothing.
 *
 *   app.jobs.interval-seconds (JOBS_INTERVAL_SECONDS)  how often, 300 by default; 0 or less switches the timer off (POST /api/admin/jobs/run still works)
 */
@Component
public class JobRunner {
    private static final Logger log = LoggerFactory.getLogger(JobRunner.class);
    public static final int LOCK_KEY = 727001;

    /** Takes the lock of one job of one community for the current transaction; false when another server holds it. */
    public interface JobLock { boolean tryLock(String tenant, String job); }

    private record Job(String name, java.util.function.Consumer<String> run) {}

    private final Tx tx;
    private final JobLock lock;
    private final int intervalSeconds;
    private final AmenityScheduler amenities;
    private final List<Job> jobs;
    private final ZoneId zone = ZoneId.systemDefault();   // the community's local time (set TZ / -Duser.timezone): due dates, "20:00" and "the 1st" are read on this clock
    private final java.util.concurrent.atomic.AtomicBoolean running = new java.util.concurrent.atomic.AtomicBoolean();

    public JobRunner(DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, Constants constants, Tx tx, AppProperties props, GstProvider gst,
                     CommunityMetaLoader metas, ObjectProvider<JdbcTemplate> jdbc) {
        this(repo, audit, json, clock, constants, tx, props == null || props.jobs() == null ? 300 : props.jobs().intervalSeconds(), gst, metas, advisoryLock(jdbc.getIfAvailable()));
    }

    /** For tests: no Spring, no database (lock = null takes every lock). */
    public JobRunner(DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, Constants constants, Tx tx, int intervalSeconds, GstProvider gst,
                     CommunityMetaLoader metas, JobLock lock) {
        this.tx = tx; this.intervalSeconds = intervalSeconds;
        this.lock = lock != null ? lock : (t, j) -> true;
        SystemWriter w = new SystemWriter(repo, audit, json, clock, constants);
        Notifier notifier = new Notifier(w);
        AmenitySystem system = new AmenitySystem(repo, audit, clock, constants);
        this.amenities = new AmenityScheduler(repo, new AmenityNotifier(repo, system, json), system, json, tx::run);
        UtilityTypes utility = new UtilityTypes(w);
        RecurringBills recurring = new RecurringBills(w);
        LateFees fees = new LateFees(w);
        DueReminders due = new DueReminders(w, notifier);
        EventNotifications events = new EventNotifications(w, notifier);
        ItcJob itc = new ItcJob(w, gst);
        ReportSchedules reports = new ReportSchedules(w, notifier);
        this.jobs = List.of(
                new Job("utility types", t -> { if (utility.ensure(t) && metas != null) metas.invalidate(t); }),
                new Job("amenity scheduler", t -> amenities.run(t, zone)),
                new Job("recurring bills", t -> recurring.run(t, zone)),
                new Job("late fees", t -> fees.runAuto(t, zone)),
                new Job("due reminders", t -> due.run(t, zone)),
                new Job("ballot reminders", t -> events.ballotReminders(t, zone)),
                new Job("input tax credit", itc::runAuto),
                new Job("report schedules", t -> reports.runDue(t, zone)));
    }

    /** pg_try_advisory_xact_lock: held until the job's transaction ends, so it can never be left behind by a crash. */
    static JobLock advisoryLock(JdbcTemplate jdbc) {
        if (jdbc == null) return null;
        return (tenant, job) -> Boolean.TRUE.equals(jdbc.queryForObject("SELECT pg_try_advisory_xact_lock(?, hashtext(?))", Boolean.class, LOCK_KEY, tenant + "/" + job));
    }

    @Scheduled(fixedDelayString = "#{${app.jobs.interval-seconds:300} * 1000}", initialDelayString = "#{${app.jobs.interval-seconds:300} * 1000}")
    public void tick() { if (intervalSeconds > 0) runOnce(); }

    /** One pass over every community. @return per community, per job: "ok", "skipped (another server is running it)" or "failed: ..." */
    public Map<String, Map<String, String>> runOnce() {
        Map<String, Map<String, String>> report = new LinkedHashMap<>();
        if (!running.compareAndSet(false, true)) { report.put("*", Map.of("all", "skipped (already running on this server)")); return report; }
        try {
            for (String tenant : amenities.tenants()) {
                Map<String, String> r = new LinkedHashMap<>();
                for (Job j : jobs) r.put(j.name(), runJob(tenant, j));
                report.put(tenant, r);
            }
        } finally { running.set(false); }
        return report;
    }

    private String runJob(String tenant, Job j) {
        try {
            Supplier<String> work = () -> {
                if (!lock.tryLock(tenant, j.name())) return "skipped (another server is running it)";
                j.run().accept(tenant);
                return "ok";
            };
            return tx.run(work);
        } catch (RuntimeException e) {
            log.warn("job {} failed for {}: {}", j.name(), tenant, e.toString());   // one broken community or job must not stop the others
            return "failed: " + e.getMessage();
        }
    }
}
