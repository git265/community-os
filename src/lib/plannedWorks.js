// Planned works: recurring checklists (the STP / WTP weekly, monthly and yearly works, DG checks, pool tests ...) and their rounds.
// The period rules are the server's (backend/api maintenance/domain/Planned.java): one round per checklist and period, due by a day in it.
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { storage } from './storage/index.js';
import { notify } from './notify.js';

export const FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-yearly', 'Yearly'];
export const RESULTS = ['Done', 'Not OK', 'N/A'];
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
/** A local calendar day as YYYY-MM-DD (never through UTC: a round is due on the community's day). */
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dayOf = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monthsIn = (f) => ({ Quarterly: 3, 'Half-yearly': 6, Yearly: 12 }[f] || 0);
const lastDay = (y, m0) => new Date(y, m0 + 1, 0).getDate();
const dayIn = (y, m0, dueDay) => new Date(y, m0, dueDay ? Math.max(1, Math.min(lastDay(y, m0), Number(dueDay))) : lastDay(y, m0));
/** ISO week number and its year (the week that has the Thursday). */
function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const y = t.getFullYear(); const jan4 = new Date(y, 0, 4);
  return { y, w: 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7) };
}

/**
 * The period a day falls in for a checklist: { key, start, end, dueOn, label }. dueDay: weekly 1 (Monday) to 7 (Sunday), otherwise the day of
 * the month (a short month uses its last day); dueMonth: the month within the quarter, half-year or year. Left out: the period's last day.
 */
export function periodOf(c, date = new Date()) {
  const d = typeof date === 'string' ? dayOf(date) : new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const y = d.getFullYear(); const m0 = d.getMonth(); const f = c.frequency;
  const dd = c.dueDay === '' || c.dueDay == null ? null : Number(c.dueDay); const dm = c.dueMonth === '' || c.dueMonth == null ? null : Number(c.dueMonth);
  const out = (key, start, end, due, label) => ({ key, start: isoDay(start), end: isoDay(end), dueOn: isoDay(due), label });
  if (f === 'Daily') return out(`D:${isoDay(d)}`, d, d, d, `${d.getDate()} ${MON[m0]}`);
  if (f === 'Weekly') {
    const start = addDays(d, -((d.getDay() + 6) % 7)); const { y: wy, w } = isoWeek(d);
    return out(`W:${wy}-W${pad(w)}`, start, addDays(start, 6), addDays(start, (dd ? Math.max(1, Math.min(7, dd)) : 7) - 1), `Week ${w}`);
  }
  if (f === 'Monthly') return out(`M:${y}-${pad(m0 + 1)}`, new Date(y, m0, 1), new Date(y, m0 + 1, 0), dayIn(y, m0, dd), `${MON[m0]} ${y}`);
  const months = monthsIn(f);
  if (!months) throw new Error(`How often: ${FREQUENCIES.join(', ')}`);
  const idx = Math.floor(m0 / months); const s0 = idx * months;
  const dueM = s0 + (dm ? Math.max(1, Math.min(months, dm)) : months) - 1;
  const key = f === 'Yearly' ? `Y:${y}` : f === 'Quarterly' ? `Q:${y}-Q${idx + 1}` : `H:${y}-H${idx + 1}`;
  const label = f === 'Yearly' ? `${y}` : f === 'Quarterly' ? `Q${idx + 1} ${y}` : `${idx ? 'Jul–Dec' : 'Jan–Jun'} ${y}`;
  return out(key, new Date(y, s0, 1), new Date(y, s0 + months, 0), dayIn(y, dueM, dd), label);
}
/** The period before (the one that ended before this one started). */
export const previousPeriod = (c, p) => periodOf(c, addDays(dayOf(p.start), -1));
/** When a checklist is due, in words: "every Sunday", "by the 10th of each month", "by 31 Dec each year". */
export function dueText(c) {
  const dd = c.dueDay ? Number(c.dueDay) : null; const dm = c.dueMonth ? Number(c.dueMonth) : null;
  const nth = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
  switch (c.frequency) {
    case 'Daily': return 'every day';
    case 'Weekly': return `by ${WEEKDAYS[(dd || 7) - 1]} each week`;
    case 'Monthly': return dd ? `by the ${nth(dd)} of each month` : 'by the end of each month';
    case 'Quarterly': return `${dd ? `by the ${nth(dd)}` : 'by the end'} of the ${nth(dm || 3)} month of each quarter`;
    case 'Half-yearly': return `${dd ? `by the ${nth(dd)}` : 'by the end'} of the ${nth(dm || 6)} month of each half-year`;
    case 'Yearly': return `by ${dd ? `${dd} ` : 'end of '}${MON[(dm || 12) - 1]} each year`;
    default: return '';
  }
}

/** A checklist's tasks and a round's items are JSON text (as the server keeps them); a bad value reads as none. */
export const parseList = (v) => { if (Array.isArray(v)) return v; try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } };
const uid = () => Math.random().toString(36).slice(2, 9);
export const tasksFromText = (text, old = []) => String(text || '').split('\n').map((t) => t.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean)
  .map((t) => old.find((o) => o.text === t) || { id: uid(), text: t });
/** A fresh round's items: every task of the checklist, nothing marked yet. */
export const freshItems = (c) => parseList(c.tasks).map((t) => ({ taskId: t.id, text: t.text, result: '', remark: '', ticketRef: '' }));
/** A round's items against its checklist today: tasks added since are added, the rest keep what was marked. */
export function itemsFor(c, round) {
  const had = parseList(round?.items);
  if (!round) return freshItems(c);
  if (round.status === 'Done') return had;
  const byId = new Map(had.map((x) => [x.taskId, x]));
  return [...had, ...freshItems(c).filter((x) => !byId.has(x.taskId))];
}
export const countsOf = (items) => ({ total: items.length, done: items.filter((x) => x.result).length, notOk: items.filter((x) => x.result === 'Not OK').length });

/**
 * The board: each active checklist's current period (and its last period, when that was missed), with its round and where it stands.
 * state: 'done' | 'overdue' | 'due' (by its day) | 'missed' (the last period, never finished).
 */
export function boardOf(checklists, rounds, today = new Date()) {
  const t = isoDay(typeof today === 'string' ? dayOf(today) : today);
  const out = [];
  for (const c of checklists) {
    if (c.active === false || !FREQUENCIES.includes(c.frequency)) continue;
    if (c.startsOn && c.startsOn > t) continue;
    const mine = rounds.filter((r) => r.checklistId === c.id);
    const p = periodOf(c, t);
    const counts = !c.startsOn || p.dueOn >= c.startsOn;   // started after this period's day: its first round is next period
    const round = mine.find((r) => r.period === p.key) || null;
    const lastDone = mine.filter((r) => r.status === 'Done').sort((a, b) => (a.dueOn < b.dueOn ? 1 : -1))[0] || null;
    if (counts) {
      const state = round?.status === 'Done' ? 'done' : t > p.dueOn ? 'overdue' : 'due';
      out.push({ checklist: c, period: p, round, state, lastDone, days: Math.round((dayOf(p.dueOn) - dayOf(t)) / 86400000) });
    }
    const prev = previousPeriod(c, p);
    const prevRound = mine.find((r) => r.period === prev.key) || null;
    if ((!c.startsOn || prev.dueOn >= c.startsOn) && prevRound?.status !== 'Done') out.push({ checklist: c, period: prev, round: prevRound, state: 'missed', lastDone, days: Math.round((dayOf(prev.dueOn) - dayOf(t)) / 86400000) });
  }
  const order = { overdue: 0, missed: 1, due: 2, done: 3 };
  return out.sort((a, b) => order[a.state] - order[b.state] || (a.period.dueOn < b.period.dueOn ? -1 : 1) || a.checklist.name.localeCompare(b.checklist.name));
}

/**
 * A sheet like the STP / WTP works list: section rows ("WTP WEEKLY WORKS", "STP YEARLY WORKS") and numbered task rows under each.
 * rows: arrays of cells. Returns [{ name, area, frequency, tasks: [text] }]. A row naming several frequencies is the sheet's title; numbered
 * tasks before any section heading are its first block, taken as weekly works.
 */
export function parseSheet(rows) {
  const out = []; let cur = null;
  const FREQ = [[/\bdaily\b/i, 'Daily'], [/\bweekl?y\b|\bweekily\b/i, 'Weekly'], [/\bmonthly\b/i, 'Monthly'], [/\bquarterly\b/i, 'Quarterly'], [/\bhalf[- ]?year(ly)?\b|\bsix[- ]monthly\b/i, 'Half-yearly'], [/\byearly\b|\bannual(ly)?\b/i, 'Yearly']];
  for (const r of rows) {
    const cells = (r || []).map((x) => String(x ?? '').trim());
    const text = cells.filter(Boolean);
    if (!text.length) continue;
    const head = text.find((x) => /\bworks?\b|\bchecks?\b|\bmaintenance\b|\bchecklist\b/i.test(x) && FREQ.some(([re]) => re.test(x)));
    const numbered = /^\d+\.?$/.test(cells[0] || '') || /^\d+\.?$/.test(text[0]);
    if (head && !numbered && FREQ.filter(([re]) => re.test(head)).length > 1) continue;   // the sheet's title: "STP AND WTP WEEKLY MONTHLY AND YEARLY WORKS-2026"
    if (head && !numbered && !/,/.test(head)) {
      const freq = (FREQ.find(([re]) => re.test(head)) || [null, 'Monthly'])[1];
      const area = head.replace(/\b(daily|weekl?y|weekily|monthly|quarterly|half[- ]?yearly|half[- ]?year|six[- ]monthly|yearly|annual(ly)?|works?|checks?|maintenance|checklist|and|(19|20)\d\d)\b/gi, '').replace(/[-–:]/g, ' ').replace(/\s+/g, ' ').trim();
      cur = { name: `${area ? `${area} ` : ''}${freq.toLowerCase()} works`.replace(/^./, (x) => x.toUpperCase()), area, frequency: freq, tasks: [] };
      out.push(cur);
      continue;
    }
    if (/^s\.?\s*no\.?$/i.test(text[0])) continue;   // the header row (S.No / Work / Remarks)
    if (!cur) {   // tasks before any section heading: the sheet's first block, weekly works
      if (!numbered) continue;
      cur = { name: 'Weekly works', area: '', frequency: 'Weekly', tasks: [] }; out.push(cur);
    }
    const task = numbered ? text.slice(1).find((x) => x && !/^remarks?$/i.test(x)) : (text.length === 1 ? text[0] : '');
    if (task) cur.tasks.push(task);
  }
  return out.filter((s) => s.tasks.length);
}

/**
 * Starter checklists: the STP / WTP works sheet (weekly, monthly, yearly) and the usual DG set, electrical panel, pump, pool and tank rounds.
 * A community adds the ones it does not have yet (Maintenance → Planned works → Starter checklists) and edits them to suit.
 */
export const STARTERS = [
  { name: 'WTP weekly works', area: 'WTP', category: 'Water & Sewage', frequency: 'Weekly', dueDay: 7, assigneeRole: 'handyman_mep', tasks: ['Clean diffusers and strainers', 'Check blower air pressure', 'Inspect dosing systems and chemical levels', 'Check all electrical panels and indicators', 'Test standby equipment', 'Inspect filter press/sludge drying bed', 'Verify float switch and level sensor operation'] },
  { name: 'WTP monthly works', area: 'WTP', category: 'Water & Sewage', frequency: 'Monthly', assigneeRole: 'handyman_mep', tasks: ['Complete filter backwash and media inspection', 'Tighten electrical terminals and panel cleaning', 'Greasing & oil of motors and pumps', 'Check pump alignment and vibration', 'Inspect pipelines for corrosion or leakage', 'Water quality laboratory testing', 'Check level switches and float valves', 'Revolve Engineers HNS Pumps inspections', 'Verify earthing system condition'] },
  { name: 'STP monthly works', area: 'STP', category: 'Water & Sewage', frequency: 'Monthly', assigneeRole: 'handyman_mep', tasks: ['Greasing, oiling of motors, blowers, and pumps', 'Tightening of electrical terminals', 'Calibration of flow meters and instruments', 'Check aeration efficiency', 'Inspect pipeline supports and structures', 'Water sample laboratory testing', 'Cleaning of tanks and chambers if required', 'Revolve Engineers HNS Pumps inspections', 'Check AMC/vendor service updates'] },
  { name: 'WTP yearly works', area: 'WTP', category: 'Water & Sewage', frequency: 'Yearly', assigneeRole: 'handyman_mep', tasks: ['Replace damaged filter media if required', 'Overhaul pumps and motors', 'Service all valves and actuators', 'Tank cleaning', 'Complete plant performance audit'] },
  { name: 'STP yearly works', area: 'STP', category: 'Water & Sewage', frequency: 'Yearly', assigneeRole: 'handyman_mep', tasks: ['Overhauling of blowers and pumps', 'Diffuser replacement if required', 'Complete electrical panel servicing', 'Instrument calibration and testing', 'Tank cleaning and sludge removal', 'Structural inspection of tanks', 'Replacement of damaged valves and pipelines'] },
  { name: 'DG set weekly run test', area: 'DG set', category: 'Electrical', frequency: 'Weekly', dueDay: 6, assigneeRole: 'handyman_electrical', tasks: ['Run the DG on load for 15 minutes', 'Check diesel level; top up below half', 'Check battery voltage and terminals', 'Check coolant and engine oil levels', 'Look for oil, fuel or coolant leaks', 'Note the running hours in the DG log'] },
  { name: 'DG set monthly checks', area: 'DG set', category: 'Electrical', frequency: 'Monthly', assigneeRole: 'handyman_electrical', tasks: ['Clean the air filter', 'Check the fuel filter and water separator', 'Check belts and hoses', 'Test the auto changeover (AMF) panel', 'Check the exhaust and silencer', 'Check the DG earthing'] },
  { name: 'DG set yearly service', area: 'DG set', category: 'Electrical', frequency: 'Yearly', assigneeRole: 'handyman_electrical', tasks: ['Engine oil and filter change (vendor service)', 'Load bank test', 'Alternator inspection and insulation test', 'Fuel tank cleaning', 'Renew statutory papers if due'] },
  { name: 'Electrical panels monthly checks', area: 'Electrical panels', category: 'Electrical', frequency: 'Monthly', assigneeRole: 'handyman_electrical', tasks: ['Thermal check of busbars and cable ends', 'Tighten loose terminals', 'Test RCCB / ELCB trip buttons', 'Clean the panels and check indicators', 'Check earth pit readings', 'Check the capacitor bank / APFC panel'] },
  { name: 'Pumps monthly checks', area: 'Pumps', category: 'Plumbing', frequency: 'Monthly', assigneeRole: 'handyman_plumbing', tasks: ['Grease pump and motor bearings', 'Check gland leakage', 'Check pressure gauges', 'Run the standby pumps', 'Check foot valves and non-return valves', 'Check starters and dry-run protection'] },
  { name: 'Swimming pool daily checks', area: 'Swimming pool', category: 'Amenities', frequency: 'Daily', assigneeRole: 'handyman_plumbing', tasks: ['Test chlorine (1–3 ppm) and pH (7.2–7.8)', 'Skim the surface and empty skimmer baskets', 'Check filter pressure; backwash if high', 'Check the water level and balancing tank', 'Write the readings in the pool log'] },
  { name: 'Water tanks half-yearly cleaning', area: 'Water tanks', category: 'Plumbing', frequency: 'Half-yearly', assigneeRole: 'handyman_plumbing', tasks: ['Drain and clean the overhead tanks', 'Drain and clean the sumps', 'Disinfect and refill', 'Check lids, vents and overflow pipes', 'Water sample test after cleaning'] },
];
/** A checklist record from a starter (or an imported sheet section): its tasks as JSON text, as the server keeps them. */
export const checklistRow = (s, startsOn = isoDay(new Date())) => ({
  name: s.name, area: s.area || '', category: s.category || '', frequency: s.frequency, dueDay: s.dueDay ?? null, dueMonth: s.dueMonth ?? null, startsOn,
  assigneeRole: s.assigneeRole || null, assigneeId: null, tasks: JSON.stringify(s.tasks.map((text, i) => ({ id: `t${i + 1}`, text }))), active: true, notes: '',
});

/**
 * The browser demo's reminders (on the server, config/Jobs.java remindPlannedWorks does this): on the day a round is due, to its team or
 * person; once past that day and not finished, to them and the Facility Manager - once each per checklist and period.
 */
export async function runPlannedReminders(now = new Date()) {
  const checklists = await storage.list(C.CHECKLISTS);
  if (!checklists.length) return 0;
  const [rounds, sentRows] = await Promise.all([storage.list(C.CHECKLIST_ROUNDS), storage.list('notifications')]);
  const sent = new Set(sentRows.filter((x) => x.kind === 'planned_work').map((x) => `${x.plannedId}|${x.plannedPeriod}|${x.plannedWhen}`));
  let n = 0;
  for (const b of boardOf(checklists, rounds, now)) {
    if (b.state === 'done') continue;
    const when = b.state === 'due' ? (b.days === 0 ? 'due' : null) : 'overdue';
    if (!when || sent.has(`${b.checklist.id}|${b.period.key}|${when}`)) continue;
    const c = b.checklist;
    const who = { ...(c.assigneeName ? { toName: c.assigneeName } : {}), toRoleIds: [...(c.assigneeRole ? [c.assigneeRole] : []), ...(when === 'overdue' || (!c.assigneeRole && !c.assigneeName) ? ['facility_manager'] : [])] };
    await notify({ event: 'planned_work', kind: 'planned_work', title: when === 'due' ? `Due today · ${c.name}` : `Not done · ${c.name}`,
      body: when === 'due' ? `${c.name} is due today. Open Maintenance → Planned works.` : `${c.name} was due ${b.period.dueOn} and is not done yet.`,
      link: '#/planned', by: 'System', extra: { plannedId: c.id, plannedPeriod: b.period.key, plannedWhen: when }, ...who });
    n += 1;
  }
  return n;
}
