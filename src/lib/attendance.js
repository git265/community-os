// Attendance: clock in / clock out with the phone's GPS position.
// The browser gives latitude/longitude/accuracy after the person allows location; we store them on the punch and compare them with the
// community's site location (Workforce -> Site & rules). Nothing is tracked in the background: a position is read only when the person taps the button.
import { logEvent } from './audit/auditLog.js';
import { secureStorage } from './storage/secureStorage.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { getPrincipal } from './security/principal.js';
import { SHIFT_TYPES } from './shifts.js';

/** Roles that clock in (field and facility staff). Everyone else sees no clock button. */
export const isClockRole = (role) => !!role && role.category === 'Staff';
export const ENFORCE = { record: 'Record only (flag exceptions)', need: 'Require location', inside: 'Require location inside the site' };

export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
export const mapLink = (lat, lng) => (lat || lat === 0 ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}` : '');

export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000; const rad = (x) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Current position, or { error } (denied, unavailable, timeout, not supported). Never throws. */
export function getPosition(timeout = 12000) {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { resolve({ error: 'This device or browser cannot share its location' }); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), acc: Math.round(pos.coords.accuracy || 0) }),
      (err) => resolve({ error: err.code === 1 ? 'Location permission was denied' : err.code === 3 ? 'Location request timed out' : 'Location is unavailable', code: err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
    );
  });
}

/** Where is the punch relative to the site? */
export function siteCheck(pos, settings) {
  if (!pos || pos.error) return { site: 'Location unavailable', dist: null };
  if (!settings?.siteLat && settings?.siteLat !== 0) return { site: 'No site location set', dist: null };
  const dist = distanceM(pos.lat, pos.lng, Number(settings.siteLat), Number(settings.siteLng));
  const radius = Number(settings.radiusM) || 300;
  return { site: dist <= radius ? 'Inside site' : 'Outside site', dist };
}

/** Keep the older "on duty" flag on the field-staff record (used to route tasks to people who are working) in step with the punches. */
async function syncOnDuty(name, on) {
  try {
    const h = (await secureStorage.list(C.HANDYMEN)).find((x) => x.name === name);
    if (h && !!h.clockedIn !== on) await secureStorage.put(C.HANDYMEN, { ...h, clockedIn: on });
  } catch { /* best effort */ }
}
/** The signed-in person's open (not yet clocked-out) session, if any. */
export async function openSession() {
  const p = getPrincipal();
  return (await secureStorage.list(C.ATTENDANCE).catch(() => [])).filter((r) => r.staffName === p?.name && !r.clockOut).sort((a, b) => String(b.clockIn).localeCompare(String(a.clockIn)))[0] || null;
}

export async function loadSettings() { return (await secureStorage.list(C.ATTENDANCE_SETTINGS))[0] || {}; }

/** Start a session. Returns { row } or { blocked: reason }. */
export async function clockIn({ shiftType = '' } = {}) {
  const p = getPrincipal();
  const settings = await loadSettings();
  const pos = await getPosition();
  const chk = siteCheck(pos, settings);
  if (settings.enforcement === ENFORCE.need && pos.error) return { blocked: `${pos.error}. Clock-in needs your location - allow location access and try again.` };
  if (settings.enforcement === ENFORCE.inside && (pos.error || chk.site !== 'Inside site')) return { blocked: pos.error ? `${pos.error}. Clock-in needs your location.` : `You are ${chk.dist ?? '?'} m from the site - clock in when you arrive.` };
  const now = new Date();
  // the shift this person is on today (planned row, else their usual shift) -> minutes late beyond the grace period
  let shift = shiftType; let lateMin = 0;
  try {
    const staff = (await secureStorage.list(C.HANDYMEN)).find((h) => h.name === p.name);
    const planned = staff ? (await secureStorage.list(C.SHIFTS)).find((r) => r.staffId === staff.id && r.date === localDate(now)) : null;
    shift = shift || planned?.shiftType || staff?.shift || '';
    const t = SHIFT_TYPES.find((x) => x.key === shift)?.time || '';
    const m = /^(\d\d):(\d\d)/.exec(t);
    if (m && shift !== 'Off' && shift !== 'Night') lateMin = Math.max(0, Math.round((now.getHours() * 60 + now.getMinutes()) - (Number(m[1]) * 60 + Number(m[2])) - (Number(settings.graceMinutes) || 15)));
  } catch { /* lateness is best effort */ }
  const row = await secureStorage.put(C.ATTENDANCE, {
    staffName: p.name, roleName: p.role?.name || '', date: localDate(now), clockIn: now.toISOString(), clockOut: '', source: 'Self', shiftType: shift, lateMin,
    inLat: pos.lat ?? null, inLng: pos.lng ?? null, inAcc: pos.acc ?? null, inSite: chk.site, inDist: chk.dist, note: pos.error || '',
  });
  await syncOnDuty(p.name, true);
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.ATTENDANCE } }));
  return { row, pos, chk };
}

export async function clockOut(open) {
  const settings = await loadSettings();
  const pos = await getPosition();
  const chk = siteCheck(pos, settings);
  if (settings.enforcement === ENFORCE.need && pos.error) return { blocked: `${pos.error}. Clock-out needs your location - allow location access and try again.` };
  const now = new Date();
  const hours = Math.max(0, Math.round(((now - new Date(open.clockIn)) / 3600000) * 100) / 100);
  const row = await secureStorage.put(C.ATTENDANCE, { ...open, clockOut: now.toISOString(), hours, outLat: pos.lat ?? null, outLng: pos.lng ?? null, outAcc: pos.acc ?? null, outSite: chk.site, outDist: chk.dist });
  await syncOnDuty(getPrincipal()?.name, false);
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.ATTENDANCE } }));
  return { row, pos, chk };
}

/** Per-person totals for a list of sessions (open sessions count up to "now"). */
export function summarise(rows) {
  const by = new Map();
  for (const r of rows) {
    const s = by.get(r.staffName) || { name: r.staffName, role: r.roleName, days: new Set(), hours: 0, sessions: 0, late: 0, outside: 0, noGps: 0, open: 0 };
    s.days.add(r.date); s.sessions += 1;
    const h = r.clockOut ? Number(r.hours) || 0 : Math.max(0, (Date.now() - new Date(r.clockIn)) / 3600000);
    s.hours += h; if (!r.clockOut) s.open += 1;
    if (Number(r.lateMin) > 0) s.late += 1;
    if (r.inSite === 'Outside site' || r.outSite === 'Outside site') s.outside += 1;
    if (r.inSite === 'Location unavailable') s.noGps += 1;
    by.set(r.staffName, s);
  }
  return [...by.values()].map((s) => ({ ...s, days: s.days.size, hours: Math.round(s.hours * 100) / 100 })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Duty safeguards: the portal needs an open session, and a forgotten clock-out is reminded, then closed automatically ----
export const DUTY_DEFAULTS = { requireClockIn: true, maxShiftHours: 12, remindEveryMin: 30 };
/** When should this session end? The planned shift end if the shift is known (+ 30 min), otherwise 8 h after clock-in. */
export function plannedEnd(open) {
  const t = SHIFT_TYPES.find((x) => x.key === open?.shiftType)?.time || '';
  const m = /–(\d\d):(\d\d)$/.exec(t);
  const start = new Date(open.clockIn);
  if (m && open.shiftType !== 'Off') {
    const e = new Date(start); e.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (e <= start) e.setDate(e.getDate() + 1);
    return e;
  }
  return new Date(start.getTime() + 8 * 3600000);
}
/** 'ok' | 'due' (shift over: remind) | 'over' (long past: will be closed automatically) */
export function dutyState(open, settings = {}) {
  if (!open) return { key: 'off' };
  const max = Number(settings.maxShiftHours) || DUTY_DEFAULTS.maxShiftHours;
  const now = Date.now(); const hours = (now - new Date(open.clockIn)) / 3600000;
  const end = plannedEnd(open);
  if (hours >= max) return { key: 'over', end, hours, max };
  if (now >= end.getTime()) return { key: 'due', end, hours, max, overMin: Math.round((now - end.getTime()) / 60000) };
  return { key: 'ok', end, hours, max, leftMin: Math.round((end.getTime() - now) / 60000) };
}

/**
 * Runs every minute while a staff member is signed in: reminds (in-app notification, repeated) once the shift is over and
 * closes the session automatically after `maxShiftHours`, flagged Auto so a supervisor can correct it. Works on raw storage (system action).
 */
export async function runDutyWatch(open, settings = {}) {
  if (!open) return null;
  const st = dutyState(open, settings);
  const { storage } = await import('./storage/index.js');
  const { pushNotification } = await import('./notifications.js');
  if (st.key === 'over') {
    const end = new Date(new Date(open.clockIn).getTime() + st.max * 3600000);
    await storage.put(C.ATTENDANCE, { ...open, clockOut: end.toISOString(), hours: st.max, source: 'Auto', note: `${open.note ? `${open.note} · ` : ''}Clock-out was forgotten - closed automatically after ${st.max} h. Supervisor: please correct if needed.` });
    logEvent({ who: 'System · auto clock-out', what: 'Attendance', action: 'Update', recordId: open.id, recordShortId: open.shortId || '', summary: `${open.staffName} was clocked out automatically after ${st.max} h (forgot to clock out)` });
    await syncOnDuty(open.staffName, false);
    await pushNotification({ id: `clk-auto-${open.id}`, kind: 'attendance', title: 'You were clocked out automatically', body: `You forgot to clock out, so today's session was closed after ${st.max} hours. Ask your supervisor if the time is wrong.`, link: '#/workforce', toName: open.staffName, createdAt: new Date().toISOString(), read: false });
    window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.ATTENDANCE } }));
    return 'auto';
  }
  if (st.key === 'due') {
    const every = (Number(settings.remindEveryMin) || DUTY_DEFAULTS.remindEveryMin) * 60000;
    const last = Number(open.lastRemindedAt) || 0;
    if (Date.now() - last >= every) {
      await storage.put(C.ATTENDANCE, { ...open, lastRemindedAt: Date.now() });
      await pushNotification({ id: `clk-rem-${open.id}-${Date.now()}`, kind: 'attendance', title: 'Your shift is over - clock out', body: `Your shift ended at ${hhmm(st.end.toISOString())}. Tap to clock out so your hours are right.`, link: '#/workforce', toName: open.staffName, createdAt: new Date().toISOString(), read: false });
      return 'reminded';
    }
  }
  return null;
}

// ---- the gate beside the clock (the same rules as the server's Attendance.withGate) ----
export const GATE_FLAGS = { NO_GATE: 'No gate entry', BEFORE_GATE: 'Clocked in before the gate', LEFT_EARLY: 'Left the gate before clocking out', LEFT_CLOCKED: 'Left without clocking out', STAYED: 'Inside after clocking out', GATE_ONLY: 'At the gate, not clocked in' };
const hoursBetween = (a, b) => Math.round(((new Date(b) - new Date(a)) / 3600000) * 100) / 100;
/** A staff member's badge visits as stays: who (member id or, for older records, "user:<id>"), name, in and out. */
export const gateStays = (visits) => visits.filter((v) => (v.memberId || String(v.personId || '').startsWith('user:')) && v.inAt && ['Inside', 'Exited', 'Auto-closed'].includes(v.state))
  .map((v) => ({ memberId: v.memberId || String(v.personId).slice(5), name: v.name, in: v.inAt, out: v.state === 'Inside' ? '' : v.outAt || '' }));
const NEAR_MS = 4 * 3600000;   // a badge up to four hours before or after a session still belongs to it
/**
 * Each badge stay goes to the person's session it falls in or near (the closest clock-in wins), so a night shift across midnight keeps its
 * gate times; stays near no session are days seen only at the gate. People are matched by member id, else by name (browser sessions carry
 * the name). "No gate entry" only from the first staff badge on.
 */
export function withGate(sessions, stays, toleranceMin = 15, now = Date.now()) {
  const tol = Math.max(0, Number(toleranceMin) || 0) * 60000; const t = (x) => new Date(x).getTime();
  const same = (s, g) => (s.memberId && g.memberId ? s.memberId === g.memberId : String(s.staffName || '').trim().toLowerCase() === String(g.name || '').trim().toLowerCase());
  const mine = new Map(sessions.map((s) => [s, []])); const loose = new Map();
  for (const g of stays) {
    if (!g.in) continue;
    let best = null;
    for (const s of sessions) {
      if (!same(s, g)) continue;
      const end = s.clockOut ? t(s.clockOut) : now;
      if (t(g.in) < t(s.clockIn) - NEAR_MS || t(g.in) > end + NEAR_MS) continue;
      if (!best || Math.abs(t(g.in) - t(s.clockIn)) < Math.abs(t(g.in) - t(best.clockIn))) best = s;
    }
    if (best) mine.get(best).push(g);
    else { const k = `${String(g.name || g.memberId).toLowerCase()}|${localDate(new Date(g.in))}`; (loose.get(k) || loose.set(k, []).get(k)).push(g); }
  }
  const span = (g) => {
    if (!g.length) return { gateIn: '', gateOut: '', gateInside: false, gateHours: null };
    const inside = g.some((x) => !x.out);
    return { gateIn: g.map((x) => x.in).sort()[0], gateOut: inside ? '' : g.map((x) => x.out).sort().slice(-1)[0], gateInside: inside,
      gateHours: Math.round(g.reduce((n, x) => n + hoursBetween(x.in, x.out || now), 0) * 100) / 100 };
  };
  const firstBadge = stays.reduce((m, g) => (g.in && (!m || t(g.in) < m) ? t(g.in) : m), 0); const out = [];   // the gate records staff from its first badge on
  for (const [s, g] of mine) {
    const sp = span(g); const flags = [];
    if (!g.length) { if (firstBadge && t(s.clockIn) >= firstBadge - NEAR_MS) flags.push(GATE_FLAGS.NO_GATE); } else {
      if (t(s.clockIn) < t(sp.gateIn) - tol) flags.push(GATE_FLAGS.BEFORE_GATE);
      if (s.clockOut && sp.gateOut && t(sp.gateOut) < t(s.clockOut) - tol) flags.push(GATE_FLAGS.LEFT_EARLY);
      if (!s.clockOut && sp.gateOut) flags.push(GATE_FLAGS.LEFT_CLOCKED);
      if (s.clockOut && ((sp.gateInside && now > t(s.clockOut) + tol) || (sp.gateOut && t(sp.gateOut) > t(s.clockOut) + tol))) flags.push(GATE_FLAGS.STAYED);
    }
    out.push({ ...s, ...sp, flags });
  }
  for (const [k, g] of loose) out.push({ id: `gate-${k}`, memberId: g[0].memberId, staffName: g[0].name, date: k.split('|').pop(), clockIn: '', clockOut: '', gateOnly: true, ...span(g), flags: [GATE_FLAGS.GATE_ONLY] });
  return out.sort((a, b) => `${b.date}${b.clockIn || b.gateIn}`.localeCompare(`${a.date}${a.clockIn || a.gateIn}`));
}

/**
 * The attendance report for a period: on the back end the server builds it (its own scope: supervisors everyone, staff themselves);
 * in the browser demo the same rules run here over the sessions and the gate's staff visits.
 */
export async function loadReport({ from, to, memberId = '', mineOnly = false } = {}) {
  const { getDataSource } = await import('./storage/dataSource.js');
  if (getDataSource().mode === 'v2') {
    const { apiFetch } = await import('./net/request.js'); const { reportLineOf } = await import('./storage/v2/v2map.js');
    const q = new URLSearchParams(Object.entries({ from, to, memberId }).filter(([, v]) => v));
    const res = await apiFetch(`/v1/workforce/attendance/report?${q}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.detail || `Attendance report: ${res.status}`);
    return body.map(reportLineOf);
  }
  const { storage } = await import('./storage/index.js');
  const me = getPrincipal()?.name;
  const [sessions, visits, settings] = await Promise.all([secureStorage.list(C.ATTENDANCE), storage.list(C.GATE_VISITS).catch(() => []), loadSettings().catch(() => ({}))]);
  const inPeriod = (d, slack = 0) => { const day = (x, n) => localDate(new Date(new Date(`${x}T12:00:00`).getTime() + n * 86400000)); return (!from || d >= day(from, -slack)) && (!to || d <= day(to, slack)); };
  // badges a day either side, so a night shift's gate times are found; days seen only at the gate stay inside the period
  const stays = gateStays(visits).filter((g) => inPeriod(localDate(new Date(g.in)), 1) && (!mineOnly || g.name === me));
  return withGate(sessions.filter((s) => inPeriod(s.date) && (!mineOnly || s.staffName === me)), stays, settings.graceMinutes ?? 15).filter((l) => !l.gateOnly || inPeriod(l.date));
}
