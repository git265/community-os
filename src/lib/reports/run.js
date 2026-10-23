// Produces and delivers scheduled reports. runReportSchedules() is idempotent (lastRunKey) and is called by the 5-minute scheduler in App.
import { storage, COLLECTIONS as C } from '../storage/index.js';
import { deliverDirect, unitsWithPeople } from '../notify.js';
import { logEvent } from '../audit/auditLog.js';
import { uuid } from '../uuid.js';
import { REPORTS, reportOf, defOf, loadData, buildReport, textOf, iso, optsOf } from './catalog.js';
import { getDataSource } from '../storage/dataSource.js';
import { runReportNow } from '../storage/v2/V2ApiAdapter.js';
// On the v2 back end the server builds, sends and records scheduled reports (its own job runs them when due); custom reports stay on the screen.
const onServer = () => getDataSource().mode === 'v2';

export const FREQUENCIES = ['Daily', 'Weekly', 'Monthly'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const AUDIENCES = ['Roles', 'People', 'All villas', 'Selected villas'];
const changed = (c) => window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: c } }));
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** The key of the run that is due now, or '' when nothing is due (so a schedule runs once per day / week / month). */
export function dueKey(s, now = new Date()) {
  if (!s.active || !s.reportType) return '';
  const today = iso(now); if (hhmm(now) < (s.time || '08:00')) return '';
  let key = '';
  if (s.frequency === 'Weekly') { if (WEEKDAYS[now.getDay()] !== (s.weekday || 'Monday')) return ''; key = today; }
  else if (s.frequency === 'Monthly') { const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(); if (now.getDate() !== Math.min(Number(s.monthDay) || 1, last)) return ''; key = today; }
  else key = today;
  return s.lastRunKey === key ? '' : key;
}

const splitExtra = (t) => String(t || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
export const audienceText = (s) => ({ Roles: `${(s.roleIds || []).length} role${(s.roleIds || []).length === 1 ? '' : 's'}`, People: `${(s.people || []).length} ${(s.people || []).length === 1 ? 'person' : 'people'}`, 'All villas': 'All villas', 'Selected villas': `${(s.units || []).length} villa${(s.units || []).length === 1 ? '' : 's'}` }[s.audience] || '') + (splitExtra(s.extra).length ? ` + ${splitExtra(s.extra).length} other` : '');

/** Build a report for a schedule (no sending). Returns the whole-community version. */
export async function previewSchedule(s, now = new Date()) {
  const def = defOf(s); if (!def) throw new Error('Unknown report');
  const data = await loadData(def.needs);
  return { def, data, rep: buildReport(def, { data, periodId: s.period, today: iso(now), opts: optsOf(s) }) };
}

export async function runSchedule(s, { now = new Date(), by = 'System · scheduled reports', manual = false } = {}) {
  if (onServer()) {
    if (s.reportType === 'custom') throw new Error('On this back end a custom report is previewed on the screen; scheduled sending is for the built-in reports.');
    const r = await runReportNow(s.id); changed(C.REPORT_RUNS); changed(C.REPORT_SCHEDULES);   // the server stamps the schedule's last run too
    return { rep: { title: s.name, lines: [] }, silent: !!r.silent, inApp: r.delivered || 0, queued: 0, skipped: 0, sentTo: r.sentTo };
  }
  const { def, data, rep } = await previewSchedule(s, now);
  const society = (await storage.list(C.MERGE_FIELDS)).find((m) => m.token === '{{SOCIETY_NAME}}')?.defaultValue || '';
  const channels = (s.channels && s.channels.length ? s.channels : ['In-app']);
  const fmt = s.format || 'Summary';
  const extraTo = splitExtra(s.extra).map((x) => (x.includes('@') ? { channel: 'Email', to: x } : { channel: /^\+?\d/.test(x) ? 'SMS' : 'Email', to: x }));
  const extraFor = (text) => extraTo.filter((x) => channels.includes(x.channel)).map((x) => ({ ...x, text }));
  const wholeText = textOf(rep, fmt, society);
  const items = []; let sentTo = ''; let silent = false;
  if (s.audience === 'All villas' || s.audience === 'Selected villas') {
    const units = s.audience === 'All villas' ? await unitsWithPeople() : (s.units || []);
    for (const u of units) {
      const r = def.perUnit ? buildReport(def, { data, periodId: s.period, today: iso(now), unit: u, opts: optsOf(s) }) : rep;
      if (def.perUnit && r.empty) continue;
      items.push({ title: r.title, body: textOf(r, fmt, society), toUnit: u, by });
    }
    sentTo = `${items.length} villa${items.length === 1 ? '' : 's'}${def.perUnit ? ' (each sees only its own)' : ''}`;
    if (extraTo.length) { items.push({ title: rep.title, body: wholeText, extraTo }); sentTo += ` + ${extraTo.length} other`; }
  } else {
    const it = { title: rep.title, body: wholeText, by, extraTo };
    if (s.audience === 'People') (s.people || []).forEach((n) => items.push({ ...it, toName: n, extraTo: [] }));
    else items.push({ ...it, toRoleIds: s.roleIds || [], extraTo: [] });
    if (extraTo.length) items.push({ title: rep.title, body: wholeText, extraTo });
    sentTo = audienceText(s);
  }
  if (!manual && s.skipEmpty && rep.empty) silent = true;
  let res = { inApp: 0, queued: 0, skipped: 0 };
  if (!silent) res = await deliverDirect(items, channels, 'report');
  const runAt = now.toISOString();
  if (!silent) {
    await storage.put(C.REPORT_RUNS, { id: uuid(), scheduleId: s.id || '', name: s.name || rep.title, runAt, title: rep.title, summary: rep.lines.join('\n'), columns: rep.columns, rows: JSON.stringify(rep.rows), sentTo: `${sentTo} · ${channels.join(', ')}${manual ? ' · run by hand' : ''}`, recordCreatedAt: runAt, recordCreatedBy: by, lastUpdatedAt: runAt, lastUpdatedBy: by });
    changed(C.REPORT_RUNS);
  }
  if (s.id && !manual) { await storage.put(C.REPORT_SCHEDULES, { ...s, lastRunKey: iso(now) }); changed(C.REPORT_SCHEDULES); }
  logEvent({ who: by, what: 'Reports', action: 'Create', summary: silent ? `${s.name}: nothing to report, not sent` : `${s.name}: sent to ${sentTo} (${channels.join(', ')})` });
  return { rep, silent, ...res, sentTo };
}

/** Called by the scheduler: runs every schedule that is due now. Returns how many ran. */
export async function runReportSchedules(now = new Date()) {
  if (onServer()) return 0;   // the server's job sends them
  const list = (await storage.list(C.REPORT_SCHEDULES)).filter((s) => dueKey(s, now));
  let n = 0;
  for (const s of list) { try { await runSchedule(s, { now }); n += 1; } catch (e) { console.warn('report failed', s.name, e); } }
  return n;
}
export { REPORTS };
