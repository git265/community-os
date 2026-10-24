// Builds a unit's statement of account from bills, payments, advances and credit notes (no separate ledger to keep in sync).
//   billed  = every bill at its original amount (before any advance was applied) - late fees included
//   credits = payments received on bills + advances received + credit notes
//   an advance that later pays a bill is NOT counted twice: it counts when received, not when applied.
import { localDay } from '../locale.js';
import { storage, COLLECTIONS as C } from '../storage/index.js';
import { r2, todayIso } from '../finance/rules.js';

const day = (s) => localDay(s || '');
export async function buildStatement(unit, from, to = todayIso()) {
  const [dues, credits, props] = await Promise.all([storage.list(C.DUES), storage.list(C.UNIT_CREDITS), storage.list(C.PROPERTIES)]);
  const ev = [];
  for (const d of dues.filter((x) => x.unit === unit)) {
    const gross = Number(d.grossAmount) || Number(d.amount) || 0;
    ev.push({ date: day(d.recordCreatedAt) || day(d.dueDate), ref: d.shortId, desc: `${d.category}${d.billedMonth ? ` · ${d.billedMonth}` : ''} (due ${day(d.dueDate)})`, debit: gross, credit: 0 });
    if (d.status === 'Paid' && d.paymentMode !== 'Unit credit' && Number(d.amount) > 0) ev.push({ date: day(d.paidAt) || day(d.dueDate), ref: d.receiptNo || d.shortId, desc: `Payment received · ${d.paymentMode || ''}${d.paymentRef && d.paymentRef !== '—' ? ` ${d.paymentRef}` : ''}`, debit: 0, credit: Number(d.amount) });
  }
  for (const c of credits.filter((x) => x.unit === unit && ['Advance', 'Credit note'].includes(x.kind) && x.type === 'Credit')) {
    ev.push({ date: day(c.date) || day(c.recordCreatedAt), ref: c.shortId || '', desc: c.kind === 'Advance' ? 'Advance received' : `Credit note · ${String(c.reason || '').replace(/^Credit note: /, '')}`, debit: 0, credit: Number(c.amount) });
  }
  ev.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (b.debit ? 1 : 0) - (a.debit ? 1 : 0));
  const before = ev.filter((e) => e.date < from); const inside = ev.filter((e) => e.date >= from && e.date <= to);
  const opening = r2(before.reduce((n, e) => n + e.debit - e.credit, 0));
  let bal = opening;
  const rows = inside.map((e) => { bal = r2(bal + e.debit - e.credit); return { ...e, balance: bal }; });
  const owner = props.find((p) => p.unit === unit)?.owner || '';
  return { unit, owner, from, to, opening, rows, closing: bal, summary: [{ label: 'Billed', value: r2(inside.reduce((n, e) => n + e.debit, 0)) }, { label: 'Paid / credited', value: r2(inside.reduce((n, e) => n + e.credit, 0)) }] };
}
