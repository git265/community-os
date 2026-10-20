// Cultural events: totals shown to everyone and receipt numbers.
// Residents may not read other households' donations, so each event row carries the community-wide totals
// (collected / pledged / contributing households / spent). They are recomputed from the raw rows after every
// donation or expense change (a Spring Boot service does the same in one SQL aggregate).
import { storage } from './storage/index.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';

const SYSTEM = 'System · cultural';

export function totalsOf(donations = [], expenses = []) {
  const rec = donations.filter((d) => d.status === 'Received');
  return {
    collected: rec.reduce((s, d) => s + (Number(d.amount) || 0), 0),
    pledged: donations.filter((d) => d.status === 'Pledged').reduce((s, d) => s + (Number(d.amount) || 0), 0),
    families: new Set(donations.map((d) => d.unit || d.donor)).size,
    donors: new Set(rec.map((d) => d.unit || d.donor)).size,
    spent: expenses.filter((e) => e.status === 'Approved' || e.status === 'Paid').reduce((s, e) => s + (Number(e.amount) || 0), 0),
  };
}

export async function recomputeEventTotals(eventId) {
  if (!eventId) return;
  const ev = await storage.get(C.CULTURAL_EVENTS, eventId);
  if (!ev) return;
  const [d, x] = await Promise.all([storage.list(C.CULTURAL_DONATIONS), storage.list(C.CULTURAL_EXPENSES)]);
  const t = totalsOf(d.filter((r) => r.eventId === eventId), x.filter((r) => r.eventId === eventId));
  if (['collected', 'pledged', 'donors', 'families', 'spent'].every((k) => ev[k] === t[k])) return;
  await storage.put(C.CULTURAL_EVENTS, { ...ev, ...t, lastUpdatedBy: ev.lastUpdatedBy || SYSTEM });
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.CULTURAL_EVENTS } }));
}

/** Next receipt number for an event: <EVENT-CODE>-0001 (code = initials of the event name + year). */
export async function nextReceiptNo(ev) {
  const code = (ev.name || 'EVT').split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).map((w) => w[0].toUpperCase()).join('').slice(0, 4) + String(ev.startDate || '').slice(2, 4);
  const rows = (await storage.list(C.CULTURAL_DONATIONS)).filter((r) => r.eventId === ev.id && r.receiptNo);
  const max = rows.reduce((m, r) => Math.max(m, Number(String(r.receiptNo).split('-').pop()) || 0), 0);
  return `${code}-${String(max + 1).padStart(4, '0')}`;
}
