// Turns a stored record (bill, booking, pledge) into the data a printable receipt needs, then into HTML.
import { getLetterhead } from './letterhead.js';
import { receiptHtml, statementHtml } from './templates.js';
import { buildStatement } from './statement.js';
import { taxBreakdown } from '../billText.js';
import { storage, COLLECTIONS as C } from '../storage/index.js';
import { money } from '../locale.js';
import { lateFeeSettings, finalDue } from '../finance/rules.js';

const paidStamp = (rec, key) => rec?.dateStamps?.[key] || (rec?.paidAt && rec.paidAt.length > 10 ? rec.paidAt : rec?.lastUpdatedAt) || rec?.paidAt;

/** Receipt for a paid bill (maintenance, water, DG, levy, late fee ...). Unpaid bills print as "payment due". */
export async function billReceipt(due) {
  const lh = await getLetterhead();
  const owner = (await storage.list(C.PROPERTIES)).find((x) => x.unit === due.unit);
  const paid = due.status === 'Paid';
  const gross = Number(due.grossAmount) || Number(due.amount) || 0;
  const credit = Number(due.creditApplied) || 0;
  const lines = [];
  if (due.readingId) {
    lines.push({ label: `${due.category} · ${due.billedMonth || ''}: ${due.unitsConsumed} units × ${money(due.ratePerUnit)}`, amount: (Number(due.unitsConsumed) || 0) * (Number(due.ratePerUnit) || 0) });
    if (Number(due.fixedCharge)) lines.push({ label: 'Fixed charge', amount: Number(due.fixedCharge) });
    const tb = taxBreakdown({ amount: gross, flatTax: due.tax });
    tb.lines.forEach((l) => lines.push({ label: l.label, amount: l.amount }));
  } else lines.push({ label: `${due.category}${due.billedMonth ? ` · ${due.billedMonth}` : ''}`, amount: gross });
  if (credit > 0) lines.push({ label: 'Less: advance / credit applied', amount: -credit, sub: true });
  let payable = Number(due.amount) || 0;
  if (!paid && due.category !== 'Late fee') {
    try { const fd = finalDue(due, await storage.list(C.DUES), await lateFeeSettings()); if (fd.charged + fd.pending > 0) { lines.push({ label: 'Late fee', amount: fd.charged + fd.pending }); payable = fd.total; } } catch { /* bill prints without it */ }
  }
  return receiptHtml({
    lh, kind: paid ? 'Receipt' : 'Bill', no: paid ? due.receiptNo : due.shortId, unit: due.unit, payer: due.billedTo || (due.billTo === 'Tenant' ? owner?.tenant : owner?.owner) || owner?.owner || due.unit, forWhat: `${due.category}${due.billedMonth ? ` · ${due.billedMonth}` : ''} (bill ${due.shortId})`,
    issuedAt: paid ? paidStamp(due, 'paidAt') : due.recordCreatedAt, lines, total: paid && due.paymentMode === 'Unit credit' ? 0 : payable, paid,
    payment: { mode: due.paymentMode, ref: due.paymentRef === '—' ? '' : due.paymentRef, at: paidStamp(due, 'paidAt'), by: due.paidBy },
    extra: [...(paid ? [] : [{ label: 'Payable by', value: due.dueDate }]), ...(paid && due.paymentMode === 'Unit credit' ? [{ label: 'Settled from', value: 'Unit advance / credit' }] : [])],
  });
}

/** Receipt / tax invoice for an amenity booking: fee, tax split by the community's region, refundable deposit, total. */
export async function bookingReceipt(b) {
  const lh = await getLetterhead();
  const incl = b.gstMode === 'Inclusive';
  const tb = taxBreakdown({ amount: incl ? b.feeTotal : b.baseAmount, rate: b.gstRate, mode: b.gstMode });
  const lines = [{ label: `${b.amenity} · ${b.date} · ${b.slot}`, amount: tb.tax > 0 ? tb.taxable : Number(b.feeTotal) || 0 }];
  tb.lines.forEach((l) => lines.push({ label: `${l.label}${l.rate ? ` ${l.rate}%` : ''}`, amount: l.amount, sub: true }));
  if (Number(b.depositAmount) > 0) lines.push({ label: 'Refundable security deposit (no tax)', amount: Number(b.depositAmount) });
  const paid = b.paymentStatus === 'Paid' || b.paidAmount > 0;
  return receiptHtml({
    lh, kind: paid ? 'Receipt' : 'Booking invoice', no: b.shortId, unit: b.bookedFor === 'Association' ? b.association : b.unit, payer: b.bookedBy || b.recordCreatedBy || b.unit, forWhat: `${b.amenity} booking ${b.shortId}`,
    issuedAt: paid ? paidStamp(b, 'paidAt') : b.recordCreatedAt, lines, total: Number(b.totalPayable) || 0, paid,
    payment: { mode: b.paymentMode, ref: b.paymentRef, at: paidStamp(b, 'paidAt') },
    taxNote: tb.tax > 0 ? `${tb.taxName} ${tb.rate}% ${incl ? 'included in the fee' : 'added to the fee'}: taxable ${money(tb.taxable)}, tax ${money(tb.tax)}.` : '',
    extra: [{ label: 'Booked on', value: b.recordCreatedAt ? new Date(b.recordCreatedAt).toLocaleString() : '' }, ...(Number(b.depositAmount) > 0 ? [{ label: 'Deposit', value: `${b.depositStatus} - returned after the event, less any damage found` }] : [])],
    note: b.status === 'Cancelled' ? `Cancelled on ${b.cancelledAt ? new Date(b.cancelledAt).toLocaleString() : ''}.` : '',
  });
}

/** Receipt for a donation / contribution to an event. */
export async function donationReceipt(d, ev) {
  const lh = await getLetterhead();
  return receiptHtml({
    lh, kind: 'Receipt', no: d.receiptNo, unit: d.unit, payer: d.donor, forWhat: `${ev?.name || 'Event'} · ${d.kind || 'Contribution'}${d.towards ? ` · ${d.towards}` : ''}`,
    issuedAt: paidStamp(d, 'date'), lines: [{ label: `${d.kind || 'Contribution'} towards ${d.towards || 'the event'}`, amount: Number(d.amount) || 0 }], total: Number(d.amount) || 0, paid: d.status === 'Received',
    payment: { mode: d.mode, ref: d.reference, at: paidStamp(d, 'date') }, extra: d.sankalpam ? [{ label: 'Sankalpam', value: d.sankalpam }] : [],
  });
}

/** Statement of account for a unit between two dates. */
export async function unitStatement(unit, from, to) {
  const [lh, st] = await Promise.all([getLetterhead(), buildStatement(unit, from, to)]);
  const bal = await storage.list(C.UNIT_CREDITS);
  void bal;
  return statementHtml({ lh, ...st, generatedAt: new Date().toISOString() });
}

/** Several receipts in one printable document, one per page. */
export function combineDocs(htmls) {
  const inner = (h) => (h.match(/<div class="doc">([\s\S]*)<\/div><\/body>/) || [, ''])[1];
  const first = htmls[0] || '';
  const css = (first.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipts</title><style>${css}.pg{page-break-after:always;margin-bottom:30px}.pg:last-child{page-break-after:auto}</style></head><body>${htmls.map((h) => `<div class="doc pg">${inner(h)}</div>`).join('')}</body></html>`;
}
