// The scheduled work that used to run inside whichever browser happened to be open (late fees, recurring bills, reminders, amenity
// releases, report schedules ...). It runs HERE, once per interval, as "System · scheduler": each job in its own transaction, one community
// at a time, and only one server instance at a time (a PostgreSQL advisory lock), so two open browsers can no longer both create the same bill.
//
//   JOBS_INTERVAL_SECONDS=300   how often (0 = off; POST /api/admin/jobs/run runs them once, Super Admin only)
const LOCK_KEY = 727001;
export const JOBS_INTERVAL = Number(process.env.JOBS_INTERVAL_SECONDS ?? 300);
const ACTOR = 'System · scheduler';

export async function createJobs({ pool, svc, srcDir }) {
  const here = (p) => new URL(p, srcDir).href;
  const m = {
    util: await import(here('lib/utilityTypes.js')), amenity: await import(here('lib/amenityServer.js')), rules: await import(here('lib/finance/rules.js')),
    due: await import(here('lib/dueReminders.js')), extra: await import(here('lib/notifyExtra.js')), itc: await import(here('lib/finance/itc.js')), reports: await import(here('lib/reports/run.js')),
  };
  const JOBS = [
    ['utility types', () => m.util.ensureUtilityTypes()], ['amenity scheduler', () => m.amenity.runAmenityScheduler()], ['recurring bills', () => m.rules.runRecurringBills()],
    ['late fees', () => m.rules.runAutoLateFees()], ['due reminders', () => m.due.runDueReminders()], ['ballot reminders', () => m.extra.runBallotReminders()],
    ['input tax credit', () => m.itc.runAutoItc()], ['report schedules', () => m.reports.runReportSchedules()],
  ];
  let running = null;

  async function runOnce() {
    const lock = await pool.connect();
    try {
      if (!(await lock.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY])).rows[0].got) return { skipped: 'another server is running the jobs' };
      const report = {};
      for (const tenant of await svc.tenants()) {
        report[tenant] = {};
        for (const [name, fn] of JOBS) {
          try { await svc.runSystem(tenant, ACTOR, { write: true }, fn); report[tenant][name] = 'ok'; }
          catch (e) { report[tenant][name] = `failed: ${e.message}`; console.error(`[jobs] ${tenant} / ${name}:`, e.message); }
        }
      }
      return report;
    } finally { await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {}); lock.release(); }
  }
  const run = () => (running ||= runOnce().finally(() => { running = null; }));   // never two at once in this process either
  let timer = null;
  const start = () => { if (JOBS_INTERVAL > 0 && !timer) { setTimeout(() => run().catch(() => {}), 5000).unref?.(); timer = setInterval(() => run().catch(() => {}), JOBS_INTERVAL * 1000); timer.unref?.(); } };
  return { run, start };
}
