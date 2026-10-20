// Correcting a bill without rewriting history. Nothing is deleted: a wrong bill is Cancelled (with who, when and why), a corrected one is issued
// beside it and the two point at each other, and a payment recorded by mistake is reversed (the ledger line goes with it, the bill is Unpaid again).
// Everything runs through secureStorage, so permissions, the books-closed lock and the audit trail apply as for any other edit.
import { secureStorage } from '../storage/secureStorage.js';
import { COLLECTIONS as C } from '../storage/StorageAdapter.js';
import { getPrincipal } from '../security/principal.js';
import { r2 } from './rules.js';

const stamp = () => new Date().toISOString();
const note = (old, line) => [old, `${stamp().slice(0, 10)} · ${getPrincipal()?.name || 'Staff'} · ${line}`].filter(Boolean).join('\n');
const changed = () => window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.DUES } }));
const fail = (e) => ({ error: e?.message || 'Not permitted' });

/** Cancel an unpaid bill (wrong unit, duplicate, raised in error). Its unpaid late fees go with it. */
export async function cancelBill(due, reason) {
  if (!String(reason || '').trim()) return { error: 'Give a reason' };
  if (due.status === 'Paid') return { error: 'This bill is paid. Reverse the payment first.' };
  if (due.status === 'Cancelled') return { error: 'This bill is already cancelled' };
  try {
    const who = getPrincipal()?.name || '';
    const fees = (await secureStorage.list(C.DUES)).filter((d) => d.lateFeeFor === due.id && !['Paid', 'Cancelled'].includes(d.status));
    for (const f of fees) await secureStorage.put(C.DUES, { ...f, status: 'Cancelled', originalAmount: Number(f.amount) || 0, amount: 0, cancelReason: `Parent bill ${due.shortId || ''} cancelled`, cancelledAt: stamp(), cancelledBy: who });
    const out = await secureStorage.put(C.DUES, { ...due, status: 'Cancelled', originalAmount: Number(due.amount) || 0, amount: 0, cancelReason: reason.trim(), cancelledAt: stamp(), cancelledBy: who, correctionNote: note(due.correctionNote, `Cancelled: ${reason.trim()}`) });
    changed(); return { due: out, lateFees: fees.length };
  } catch (e) { return fail(e); }
}

/** Replace an unpaid bill with a corrected one (another unit, amount or due date). The old one is cancelled and linked to the new one. */
export async function reissueBill(due, { unit, amount, dueDate }, reason) {
  if (!String(reason || '').trim()) return { error: 'Give a reason' };
  if (due.status === 'Paid') return { error: 'This bill is paid. Reverse the payment first.' };
  const amt = r2(amount); if (!(amt > 0)) return { error: 'Enter the correct amount' };
  if (!String(unit || '').trim()) return { error: 'Choose the unit' };
  if (!dueDate) return { error: 'Choose the payable-by date' };
  try {
    const props = await secureStorage.list(C.PROPERTIES);
    if (props.length && !props.some((p) => p.unit === unit.trim())) return { error: `${unit} is not a unit in this community` };
    const keep = ['category', 'billedMonth', 'billTo', 'billedTo', 'levyId', 'tax', 'taxRate', 'fixedCharge', 'planGroup'];
    const fresh = { unit: unit.trim(), amount: amt, dueDate, status: 'Unpaid', correctionOf: due.shortId || due.id, correctionNote: note('', `Replaces ${due.shortId || ''} (${due.unit}, ${due.amount}): ${reason.trim()}`) };
    keep.forEach((k) => { if (due[k] !== undefined) fresh[k] = due[k]; });
    const created = await secureStorage.put(C.DUES, fresh);
    if (!created) return { error: 'Not permitted' };
    const cancelled = await cancelBill({ ...due }, `Replaced by ${created.shortId || 'a corrected bill'}: ${reason.trim()}`);
    if (cancelled.error) return cancelled;
    await secureStorage.put(C.DUES, { ...cancelled.due, replacedBy: created.shortId || created.id });
    changed(); return { due: created, old: cancelled.due };
  } catch (e) { return fail(e); }
}

/** A payment that was recorded wrongly: the bill is Unpaid again and its Payments line is removed (and logged). Refused once the line is matched to a bank statement. */
export async function reverseBillPayment(due, reason) {
  if (!String(reason || '').trim()) return { error: 'Give a reason' };
  if (due.status !== 'Paid') return { error: 'This bill is not marked paid' };
  try {
    const line = (await secureStorage.list(C.LEDGER).catch(() => [])).find((l) => l.sourceId === `due:${due.id}`);
    if (line?.reconStatus === 'Matched') return { error: 'This payment is matched to a bank statement line. Unmatch it in Bank matching first.' };
    const prev = `${due.paymentMode || ''} ${due.paymentRef || ''} on ${due.paidAt || ''}, receipt ${due.receiptNo || ''}`.trim();
    const out = await secureStorage.put(C.DUES, { ...due, status: 'Unpaid', paymentMode: '', paymentRef: '', paidAt: '', paidBy: '', receiptNo: '', correctionNote: note(due.correctionNote, `Payment reversed (${prev}): ${reason.trim()}`) });
    changed(); return { due: out };
  } catch (e) { return fail(e); }
}
