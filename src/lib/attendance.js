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
      (err) => resolve({ error: err.code === 1 ? 'Location permission was denied' : err.code === 3 ? 'Location request timed out' : 'Location is unavailable' }),
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
