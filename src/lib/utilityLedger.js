// Resident payments of bills (water, DG, any other utility, maintenance fee and every other due) -> Payments.
//
// Each paid bill is its own transaction in the Payments ledger: a Credit tagged with the bill (sourceId "due:<id>"), the villa, the bill
// number (DUE-xxxx), the head it belongs to (Water, DG, Maintenance fee …) and how it was paid. Un-paying a bill removes its line.
// Residents cannot write the ledger, so this is a system posting made when the bill is saved. Utility bills land in the
// Electricity/Water/Tax account; everything else in the Maintenance account (the Treasurer can re-route under Account routing).
import { localDay } from './locale.js';
import { storage } from './storage/index.js';
import { COLLECTIONS } from './storage/StorageAdapter.js';
import { logChange } from './audit/auditLog.js';
import { uuid } from './uuid.js';
import { isUtility } from './utilityTypes.js';

export const dueSourceId = (id) => `due:${id}`;
/** Which collections head a bill rolls up under in Payments → Collections. */
export const headOf = (category) => (isUtility(category) ? 'Utilities' : 'Maintenance');

/** Post (or update, or remove) the ledger transaction for one bill. Returns the entry or null. */
export async function syncDuePayment(due, { nextShortId, actor = 'System · bill payments' }) {
  if (!due?.id) return null;
  const ledger = await storage.list(COLLECTIONS.LEDGER);
  const sid = dueSourceId(due.id);
  const existing = ledger.find((l) => l.sourceId === sid);
  if (due.status !== 'Paid' || due.paymentMode === 'Unit credit') { // paid from the unit's own credit: the cash was booked when the advance arrived
    if (existing) { await storage.remove(COLLECTIONS.LEDGER, existing.id); window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.LEDGER } })); }
    return null;
  }
  const now = new Date().toISOString();
  const util = isUtility(due.category);
  const levy = due.levyId ? (await storage.list(COLLECTIONS.LEVIES)).find((l) => l.id === due.levyId) : null;
  const row = {
    ...(existing || {}),
    id: existing?.id || uuid(),
    date: localDay(due.paidAt || due.dueDate || now),
    account: existing?.account || (util ? 'Electricity/Water/Tax' : 'Maintenance'),
    description: `${due.category} bill${due.billedMonth ? ` · ${due.billedMonth}` : ''} · ${due.unit}`,
    category: due.category, type: 'Credit', amount: Number(due.amount) || 0, vendor: '',
    module: util ? 'Utilities' : 'Dues', sourceType: 'due', sourceId: sid, sourceLabel: `${due.shortId || ''} · ${due.category} · ${due.unit}`.trim(),
    fund: levy?.fund || existing?.fund || '', subCategory: levy ? `Levy › ${levy.name}` : (existing?.subCategory || ''),
    unit: due.unit, billNo: due.shortId || '', mode: due.paymentMode || '', ref: due.paymentRef || '', reconStatus: existing?.reconStatus || 'Unreconciled',
    attachments: existing?.attachments || [],
    shortId: existing?.shortId || await nextShortId(COLLECTIONS.LEDGER),
    recVersion: (existing?.recVersion ?? 0) + 1, recordCreatedAt: existing?.recordCreatedAt || now, recordCreatedBy: existing?.recordCreatedBy || actor, lastUpdatedAt: now, lastUpdatedBy: actor,
  };
  if (existing && existing.amount === row.amount && existing.date === row.date && existing.mode === row.mode) return existing;
  const saved = await storage.put(COLLECTIONS.LEDGER, row);
  await logChange({
    who: actor, whoName: actor, what: 'Payments Cross-check', collection: COLLECTIONS.LEDGER, recordId: row.id, recordShortId: row.shortId, unit: due.unit || '',
    action: existing ? 'Update' : 'Create', summary: `${row.description} · ₹${row.amount}`,
    changes: existing ? [{ field: 'amount', label: 'Amount (₹)', from: String(existing.amount), to: String(row.amount) }] : [],
  });
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.LEDGER } }));
  return saved;
}
