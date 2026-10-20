// Community calendar rules: trash pickup and "workers allowed" windows (construction / repair / contractors / delivery crews),
// plus a holiday list that overrides both on specific dates.
import { weekdayIdx, addDays } from './shifts.js';

export const KINDS = ['Trash pickup', 'Workers allowed'];

/** Does this rule apply on this date (YYYY-MM-DD)? */
export function occurs(rule, date) {
  if (!rule || !date) return false;
  const wd = Array.isArray(rule.weekdays) ? rule.weekdays.map(Number) : [];
  if (rule.repeat === 'One date') return rule.date === date;
  if (rule.repeat === 'Date range') return !!rule.date && date >= rule.date && date <= (rule.endDate || rule.date) && (!wd.length || wd.includes(weekdayIdx(date)));
  if (rule.date && date < rule.date) return false;
  if (rule.endDate && date > rule.endDate) return false;
  return wd.includes(weekdayIdx(date));
}

export const timeText = (r) => (r.startTime || r.endTime ? `${r.startTime || ''}${r.endTime ? `–${r.endTime}` : ''}` : 'All day');
export const holidayOn = (holidays = [], date) => holidays.find((h) => h.date === date) || null;

// ---- Services (Round 21) -----------------------------------------------------------------------------------------------
// A service is something the community runs on a timetable: trash pickup, workers' access, water-tanker, pest control, gardening...
// Two behaviours: 'Collection' (happens on days, can be skipped or moved by a holiday) and 'Access' (a window when something is
// allowed, can be blocked or limited by a holiday). Rules point at a service through `kind` = the service name.
export const BUILTIN_SERVICES = [
  { id: 'svc-trash', name: 'Trash pickup', icon: '🗑', mode: 'Collection', active: true },
  { id: 'svc-workers', name: 'Workers allowed', icon: '🔨', mode: 'Access', active: true },
];
export const SERVICE_MODES = { Collection: 'Happens on set days (pickup, tanker, spraying, gardening). A holiday can skip it or move it.', Access: 'A window when something is allowed (workers, deliveries, contractors). A holiday can block it or limit the hours.' };
export const EFFECTS = { Collection: ['As usual', 'No service', 'Rescheduled'], Access: ['As usual', 'Not available', 'Limited hours'] };
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const servicesOrBuiltin = (rows = []) => (rows.length ? [...rows].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)) : BUILTIN_SERVICES);
export const svcOf = (services, name) => services.find((s) => s.name === name) || BUILTIN_SERVICES.find((s) => s.name === name) || { name, icon: '📌', mode: 'Collection', active: true };

/** What a holiday does to one service: { effect, newDate, from, to }. Reads the per-service map and falls back to the original trash/workers fields. */
export function effectOf(h, svc) {
  if (!h || !svc) return { effect: 'As usual' };
  const e = h.effects?.[svc.name];
  if (e && e.effect) return e;
  if (svc.name === 'Trash pickup') return h.trash === 'No pickup' ? { effect: 'No service' } : h.trash === 'Rescheduled' ? { effect: 'Rescheduled', newDate: h.trashNewDate } : { effect: 'As usual' };
  if (svc.name === 'Workers allowed') return h.workers === 'Not allowed' ? { effect: 'Not available' } : h.workers === 'Limited hours' ? { effect: 'Limited hours', from: h.workersFrom, to: h.workersTo } : { effect: 'As usual' };
  return { effect: 'As usual' };
}
export function effectText(svc, e, fmtDate = (d) => d) {
  const x = e?.effect || 'As usual';
  if (x === 'As usual') return svc.mode === 'Collection' ? (svc.name === 'Trash pickup' ? 'Pickup as usual' : 'As usual') : 'As usual';
  if (x === 'No service') return svc.name === 'Trash pickup' ? 'No pickup' : 'No service';
  if (x === 'Rescheduled') return `Moved to ${fmtDate(e.newDate)}`;
  if (x === 'Not available') return svc.name === 'Workers allowed' ? 'Not allowed' : 'Not available';
  if (x === 'Limited hours') return `${e.from || ''}–${e.to || ''} only`;
  return x;
}

/** Collection service on a date. A holiday can cancel it ("No service") or move it to another day ("Rescheduled"). */
export function collectionOn(svc, rules, date, holidays = []) {
  const usual = (d) => rules.filter((r) => r.kind === svc.name && occurs(r, d));
  const h = holidayOn(holidays, date);
  const he = h ? effectOf(h, svc).effect : 'As usual';
  let out = he === 'No service' || he === 'Rescheduled' ? [] : usual(date);
  for (const m of holidays.filter((x) => { const e = effectOf(x, svc); return e.effect === 'Rescheduled' && e.newDate === date; })) {
    out = out.concat(usual(m.date).map((r) => ({ ...r, id: `${r.id}@${m.date}`, notes: `Moved from ${m.name} (${m.date})${r.notes ? ` · ${r.notes}` : ''}` })));
  }
  return out.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
}
/** Access service on a date: holiday first, then a one-off / date-range rule, then the usual weekly pattern. */
export function accessOn(svc, rules, date, holidays = []) {
  const h = holidayOn(holidays, date);
  const e = h ? effectOf(h, svc) : { effect: 'As usual' };
  if (e.effect === 'Not available') return { state: 'blocked', rules: [{ id: `h-${h.id}`, title: h.name, notes: h.note || 'Holiday', startTime: '', endTime: '' }], holiday: h };
  if (e.effect === 'Limited hours') return { state: 'allowed', rules: [{ id: `h-${h.id}`, title: `${h.name} (limited hours)`, notes: h.note || '', startTime: e.from || '', endTime: e.to || '' }], holiday: h };
  const hit = rules.filter((r) => r.kind === svc.name && occurs(r, date));
  if (!hit.length) return { state: 'unset', rules: [], holiday: h };
  const specific = hit.filter((r) => r.repeat !== 'Weekly');
  const pool = specific.length ? specific : hit;
  const blocked = pool.filter((r) => r.allowed === 'Not allowed');
  if (blocked.length) return { state: 'blocked', rules: blocked, holiday: h };
  return { state: 'allowed', rules: pool, holiday: h };
}
export const pickupsOn = (rules, date, holidays = []) => collectionOn(BUILTIN_SERVICES[0], rules, date, holidays);
export const workersOn = (rules, date, holidays = []) => accessOn(BUILTIN_SERVICES[1], rules, date, holidays);
/** One service on one date, whatever its behaviour. */
export const serviceDay = (svc, rules, date, holidays = []) => (svc.mode === 'Access' ? { access: accessOn(svc, rules, date, holidays) } : { items: collectionOn(svc, rules, date, holidays) });

/** The next `days` days with anything to say: pickups, worker status changes and holidays. */
export function upcoming(rules, holidays, from, days = 14) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    out.push({ date: d, pickups: pickupsOn(rules, d, holidays), workers: workersOn(rules, d, holidays), holiday: holidayOn(holidays, d) });
  }
  return out;
}

/** Parse pasted holidays: one per line "2026-12-25, Christmas" or "25/12/2026 - Christmas". Returns { rows, bad }. */
export function parseHolidays(text) {
  const rows = []; const bad = [];
  for (const raw of String(text || '').split(/\n/)) {
    const line = raw.trim(); if (!line) continue;
    const m = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})\s*[,;\t-]?\s*(.+)$/.exec(line);
    if (!m) { bad.push(line); continue; }
    let d = m[1];
    if (!/^\d{4}/.test(d)) { const [dd, mm, yy] = d.split(/[/.-]/); d = `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`; }
    if (Number.isNaN(Date.parse(`${d}T00:00:00`))) { bad.push(line); continue; }
    rows.push({ date: d, name: m[2].trim() });
  }
  return { rows, bad };
}
