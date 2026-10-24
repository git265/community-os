import { storage, COLLECTIONS } from './storage/index.js';
import { getDataSource } from './storage/dataSource.js';
import { getPrincipal } from './security/principal.js';
import { canWriteCollection } from './security/authz.js';
import { logChange } from './audit/auditLog.js';
import { nextShortId } from './storage/secureStorage.js';
import { uuid } from './uuid.js';
import { notify } from './notify.js';

export { SHIFT_TYPES } from './lists/configLists.js'; // live list: the community can edit it in Community setup -> Lists
import { SHIFT_TYPES } from './lists/configLists.js';
export const shiftTime = (k) => SHIFT_TYPES.find((s) => s.key === k)?.time || '';

export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
export const weekStart = (s) => { const d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); }; // Monday
export const monthStart = (s) => `${s.slice(0, 7)}-01`;
export const monthEnd = (s) => { const d = parse(monthStart(s)); d.setMonth(d.getMonth() + 1); d.setDate(0); return iso(d); };
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const weekdayIdx = (s) => (parse(s).getDay() + 6) % 7; // Mon=0

/** Dates from..to inclusive (max 366) restricted to the chosen weekdays (Mon=0..Sun=6). */
export function datesIn(from, to, weekdays = [0, 1, 2, 3, 4, 5, 6]) {
  const out = [];
  for (let d = from, n = 0; d <= to && n < 366; d = addDays(d, 1), n++) if (weekdays.includes(weekdayIdx(d))) out.push(d);
  return out;
}

/** The shift a person works on a date: the planned row, or their usual shift when nothing is planned. */
export function effectiveShift(staff, date, rowsByKey) {
  const row = rowsByKey.get(`${staff.id}|${date}`);
  if (row) return { shiftType: row.shiftType, planned: true, row };
  return { shiftType: staff.shift || 'General', planned: false };
}

/**
 * Plan a shift for several people over a set of dates in one go (one audit entry, not one per day).
 * Re-planning a day replaces the earlier row. Needs the "manage field-staff duties" permission.
 */
export async function planShifts({ staff, dates, shiftType, note = '' }) {
  const p = getPrincipal();
  if (!canWriteCollection(COLLECTIONS.SHIFTS, p)) throw new Error('You are not permitted to plan shifts.');
  const existing = await storage.list(COLLECTIONS.SHIFTS);
  const byKey = new Map(existing.map((r) => [`${r.staffId}|${r.date}`, r]));
  const now = new Date().toISOString();
  let n = 0;
  for (const st of staff) {
    for (const date of dates) {
      const old = byKey.get(`${st.id}|${date}`);
      const row = old
        // on the back end the version is the one read (it is sent as If-Match and the server moves it on); the browser demo counts it here
        ? { ...old, shiftType, note, lastUpdatedBy: p.name, lastUpdatedAt: now, version: getDataSource().mode === 'v2' ? old.version : (old.version || 1) + 1 }
        : { id: uuid(), shortId: await nextShortId(COLLECTIONS.SHIFTS), staffId: st.id, staffName: st.name, trade: st.trade, date, shiftType, note, recordCreatedAt: now, lastUpdatedBy: p.name, lastUpdatedAt: now, version: 1 };
      await storage.put(COLLECTIONS.SHIFTS, row);
      byKey.set(`${st.id}|${date}`, row);
      n++;
    }
  }
  const first = dates[0]; const last = dates[dates.length - 1];
  await logChange({
    who: p.name, whoName: p.name, what: 'Staff Shifts', collection: COLLECTIONS.SHIFTS, recordId: '', recordShortId: '', unit: '', action: 'Update',
    summary: `${shiftType} shift planned for ${staff.map((s) => s.name).join(', ')} · ${first}${last !== first ? ` to ${last}` : ''} (${n} day${n === 1 ? '' : 's'})`, changes: [],
  }).catch(() => {});
  const span = last !== first ? `${first} to ${last}` : first;
  for (const st of staff) notify({ event: 'shift', title: `Shift planned · ${shiftType}`, body: `You are on the ${shiftType} shift (${shiftTime(shiftType)}) for ${span}.`, link: '#/shifts', toName: st.name, by: p.name }).catch(() => {});
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.SHIFTS } }));
  return n;
}
