// Unified payment engine.
// Every rupee that leaves (or enters) a community bank account is recorded ONCE, in the Payments cross-check ledger, with:
//   - the bank account it moved through (default per area from Billing -> Payments -> Routing)
//   - the area it was FOR (Maintenance, Cultural, Utilities, Amenities, Dues, Capex...) and the exact record it pays (task, expense, bill, booking...)
//   - how it was paid and the UTR / cheque no.
// That makes two things possible: spending analysis by area, and tallying the ledger against the imported bank statement.
// With the Spring Boot backend this becomes POST /payments (one transaction: ledger row + source record status).
import { secureStorage } from './storage/secureStorage.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';

export const AREAS = ['Maintenance', 'Cultural', 'Utilities', 'Amenities', 'Dues', 'Capex / projects', 'Other'];
import { ALL_MODES } from './region/paymentModes.js';
import { tell } from './net/activity.js';
import { getDataSource } from './storage/dataSource.js';
export const MODES = ALL_MODES; // live: follows the community's country
export const DEFAULT_ROUTING = { Maintenance: 'Maintenance', Cultural: 'Cultural', Utilities: 'Electricity/Water/Tax', Amenities: 'Maintenance', Dues: 'Maintenance', 'Capex / projects': 'Sinking' };

/** The area an older ledger row belongs to (rows written before the engine carry no `module`). */
export function areaOf(l) {
  if (l.module) return l.module;
  const sid = String(l.sourceId || '');
  if (l.bookingNo || sid.startsWith('amenity:') || l.category === 'Amenities') return 'Amenities';
  if (['Water', 'DG', 'Electricity'].includes(l.category) || sid.startsWith('utility') || /water|dg |diesel|electric/i.test(l.description || '')) return 'Utilities';
  if (sid.startsWith('cultural:') || sid.startsWith('culturalCredit:') || l.sourceType === 'culturalExpense' || l.sourceType === 'culturalCredit') return 'Cultural';
  if (l.taskRef || sid) return 'Maintenance';
  if (l.type === 'Credit' && /maintenance/i.test(l.description || '')) return 'Dues';
  return 'Other';
}

export async function routingMap() {
  const rows = await secureStorage.list(C.PAYMENT_ROUTING).catch(() => []);
  const out = { ...DEFAULT_ROUTING };
  rows.forEach((r) => { if (r.module && r.account) out[r.module] = r.account; });
  return out;
}

/**
 * Record a payment. Idempotent per `sourceId`: paying the same record twice returns the existing row unless `allowDuplicate` is set (the Pay dialog sets it after the user confirms an additional payment).
 * { area, type: 'Debit'|'Credit', amount, account?, date?, mode?, ref?, vendor?, description, sourceType, sourceId, sourceLabel, taskRef?, unit?, extra? }
 */
export async function recordPayment(p) {
  const all = await secureStorage.list(C.LEDGER).catch(() => []);
  if (p.sourceId && !p.allowDuplicate) {
    const dup = all.find((l) => l.sourceId === p.sourceId && l.type === (p.type || 'Debit'));
    if (dup) return { row: dup, existing: true };
  }
  const account = p.account || (await routingMap())[p.area] || '';
  if (!account) return { error: `No bank account is set for ${p.area} payments - choose one under Billing -> Payments -> Routing` };
  if (!(Number(p.amount) > 0)) return { error: 'Enter an amount above zero' };
  let row;
  try {
    row = await secureStorage.put(C.LEDGER, {
    date: p.date || new Date().toISOString().slice(0, 10), account, description: p.description, category: p.category || p.area, type: p.type || 'Debit', amount: Number(p.amount), vendor: p.vendor || '',
    module: p.area, sourceType: p.sourceType || '', sourceId: p.sourceId || '', sourceLabel: p.sourceLabel || '', mode: p.mode || 'Bank transfer', ref: p.ref || '', reconStatus: 'Unreconciled',
    ...(p.taskRef ? { taskRef: p.taskRef } : {}), ...(p.unit ? { unit: p.unit } : {}), ...(p.extra || {}),
    });
  } catch (e) { return { error: e?.message || 'Not permitted' }; }
  if (!row) return { error: 'Not permitted' };
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.LEDGER } }));
  return { row };
}

/**
 * Correct a payment that was recorded wrongly (wrong amount, wrong task, paid twice...). History is never edited or deleted:
 * a matching CREDIT row (reversalOf) cancels it, both leave the bank-matching list, and a release that was marked Paid goes back to Approved
 * so it can be paid correctly or cancelled. Not allowed once the payment is matched to a bank statement line.
 */
const onServer = () => getDataSource().mode === 'v2';
async function unpayExpense(id) {
  const x = await secureStorage.get(C.CULTURAL_EXPENSES, id);
  if (x && x.status === 'Paid') { await secureStorage.put(C.CULTURAL_EXPENSES, { ...x, status: 'Approved', paidBy: '' }); await import('./culturalServer.js').then((m) => m.recomputeEventTotals(x.eventId)).catch(() => {}); }
}
export async function reversePayment(orig, reason) {
  const all = await secureStorage.list(C.LEDGER).catch(() => []);
  const today = new Date().toISOString().slice(0, 10);
  let row;
  try {
    row = await secureStorage.put(C.LEDGER, {
      date: today, account: orig.account, description: `Reversal of ${orig.shortId || 'payment'} · ${orig.description || ''}`.trim(), category: orig.category, type: 'Credit', amount: Number(orig.amount),
      vendor: orig.vendor || '', module: orig.module, sourceType: 'reversal', sourceId: '', sourceLabel: orig.sourceLabel || '', mode: orig.mode || 'Bank transfer', ref: `REV-${orig.shortId || ''}`,
      reconStatus: 'Not applicable', reversalOf: orig.id, reason: String(reason || '').trim(), ...(orig.taskRef ? { taskRef: orig.taskRef } : {}), ...(orig.unit ? { unit: orig.unit } : {}),
    });
  } catch (e) { return { error: e?.message || 'Not permitted' }; }
  if (!row) return { error: 'Not permitted' };
  // The reversal is booked: a failure below is said out loud, never swallowed.
  const after = [];
  try {
    const cur = (await secureStorage.get(C.LEDGER, orig.id)) || orig; // fresh, not the copy on screen
    await secureStorage.put(C.LEDGER, { ...cur, reconStatus: 'Not applicable' });
  } catch (e) { after.push(`the original payment could not be taken off bank matching (${e?.message || 'failed'})`); }
  if (orig.sourceType === 'release' && orig.sourceId) {
    try {
      const rel = await secureStorage.get(C.RELEASES, orig.sourceId);
      if (rel && rel.status === 'Paid') await secureStorage.put(C.RELEASES, { ...rel, status: 'Approved' });
      if (rel?.expenseId && !onServer()) await unpayExpense(rel.expenseId);
    } catch (e) { after.push(`its release could not be set back to Approved (${e?.message || 'failed'})`); }
  }
  // an event expense is Paid only while a payment covers it: the reversal makes it Approved (unpaid) again (the server does this itself)
  if (orig.sourceType === 'culturalExpense' && orig.sourceId && !onServer()) {
    try { await unpayExpense(String(orig.sourceId).replace(/^cultural:/, '')); } catch (e) { after.push(`its event expense could not be set back to Approved (${e?.message || 'failed'})`); }
  }
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.LEDGER } }));
  const warning = after.length ? `The reversal was recorded, but ${after.join('; ')}. Fix it by hand before paying again.` : '';
  if (warning) tell(warning);
  return { row, count: all.length, ...(warning ? { warning } : {}) };
}

/* ---------------------------------------------------------- reconciliation -- */

const dayDiff = (a, b) => Math.abs((new Date(`${a}T00:00:00`) - new Date(`${b}T00:00:00`)) / 86400000);
const amt = (t) => (Number(t.debit) > 0 ? { type: 'Debit', v: Number(t.debit) } : { type: 'Credit', v: Number(t.credit) || 0 });

/**
 * Pair unreconciled ledger rows with bank statement lines of the same account, direction and amount.
 * A UTR / cheque number found in the narration is a strong match; otherwise the nearest date within `window` days.
 * Each side is used at most once. Returns [{ ledger, txn, how }].
 */
export function suggestMatches(ledger, txns, { window = 5 } = {}) {
  const used = new Set(); const out = [];
  const open = ledger.filter((l) => l.reconStatus !== 'Matched' && l.reconStatus !== 'Not applicable' && !l.reversalOf);
  const free = txns.filter((t) => !t.matchedLedgerId);
  for (const strong of [true, false]) {
    for (const l of open) {
      if (out.some((m) => m.ledger.id === l.id)) continue;
      const cands = free.filter((t) => !used.has(t.id) && t.account === l.account && amt(t).type === l.type && Math.abs(amt(t).v - Number(l.amount)) < 0.5 && dayDiff(t.date, l.date) <= window);
      const refHit = l.ref ? cands.filter((t) => String(`${t.narration || ''} ${t.remarks || ''}`).toLowerCase().includes(String(l.ref).toLowerCase())) : [];
      const pick = strong ? refHit[0] : cands.sort((a, b) => dayDiff(a.date, l.date) - dayDiff(b.date, l.date))[0];
      if (pick) { used.add(pick.id); out.push({ ledger: l, txn: pick, how: strong ? 'Reference found in the narration' : `Same amount, ${dayDiff(pick.date, l.date)} day(s) apart` }); }
    }
  }
  return out;
}

export async function applyMatch(ledgerRow, txn) {
  const l = await secureStorage.put(C.LEDGER, { ...ledgerRow, reconStatus: 'Matched', bankTxnId: txn.id });
  const t = await secureStorage.put(C.BANK_TXNS, { ...txn, matchedLedgerId: ledgerRow.id });
  return !!(l && t);
}
export async function undoMatch(ledgerRow, txn) {
  await secureStorage.put(C.LEDGER, { ...ledgerRow, reconStatus: 'Unreconciled', bankTxnId: '' });
  if (txn) await secureStorage.put(C.BANK_TXNS, { ...txn, matchedLedgerId: '' });
}

/* ------------------------------------------------------------------- GST -- */
// Rates in force since 22 Sep 2025 ("GST 2.0"): 0 / 5 / 18 / 40. 12% and 28% were removed, so they only make sense on older invoices.
export const GST_NOW = [0, 5, 18, 40];
export const GST_LEGACY = [12, 28];
export const GST_CUTOVER = '2025-09-22';
export const validGstin = (s) => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(s || '').trim().toUpperCase());
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** What GST treatment is normal for this kind of payment: { kind: 'none'|'standard'|'goods'|'unknown', rates, note }. */
export function gstGuide(area, text = '') {
  const t = String(text).toLowerCase();
  if (/diesel|petrol|fuel/.test(t)) return { kind: 'none', rates: [0], note: 'Diesel and petrol are outside GST (state VAT is already in the price), so a GST line on a fuel bill is unusual.' };
  if (/electric|bescom|power bill|discom|water (bill|board|tax)|bwssb|property tax|municipal|panchayat|cess|\btax\b/.test(t) || (area === 'Utilities' && !/tanker|repair|service|amc/.test(t))) return { kind: 'none', rates: [0], note: 'Electricity, water-board charges and property or municipal taxes carry no GST.' };
  if (/salary|wages|stipend|bonus|payroll|refund|deposit|donation|charity|prasad/.test(t) || area === 'Dues') return { kind: 'none', rates: [0], note: 'Salaries, refunds, deposits and donations are not subject to GST.' };
  if (/insurance|premium/.test(t)) return { kind: 'standard', rates: [18], note: 'Insurance premiums attract 18% GST.' };
  if (/amc|lift|repair|maintenance|service|plumb|paint|civil|labou?r|contract|security|housekeeping|pest|garden|clean|sound|light|decor|catering|event|audit|testing|lab|inspection/.test(t) || ['Maintenance', 'Cultural', 'Amenities', 'Capex / projects'].includes(area) && /./.test(t)) return { kind: 'standard', rates: [18], note: 'Contractor and service work is normally 18%. Some food and basic goods are 5%.' };
  return { kind: 'unknown', rates: [0, 5, 18], note: 'Ask the vendor for a GST invoice. Most services are 18%, and basic goods 5%.' };
}

/**
 * Work out and sanity-check the GST on one payment.
 * mode: 'None' (no GST on the bill) | 'Included' (the amount already holds GST) | 'Extra' (GST is added on top of the amount).
 */
export function gstCheck({ amount, mode = 'None', rate = 0, date, area, text, gstin, vendor, billedGst }) {
  const a = Number(amount) || 0; const r = Number(rate) || 0;
  let base = r2(a); let gst = 0; let total = r2(a);
  if (mode === 'Included' && r > 0) { base = r2(a / (1 + r / 100)); gst = r2(a - base); }
  if (mode === 'Extra' && r > 0) { gst = r2((a * r) / 100); total = r2(a + gst); }
  const guide = gstGuide(area, text);
  const msgs = [];
  const add = (tone, m) => msgs.push({ tone, text: m });
  const hasGst = mode !== 'None' && r > 0;
  if (hasGst) {
    if (GST_LEGACY.includes(r)) add(date && date < GST_CUTOVER ? 'ok' : 'warn', date && date < GST_CUTOVER ? `${r}% was a valid rate before 22 Sep 2025.` : `${r}% was removed on 22 Sep 2025 - current rates are 5%, 18% and 40%. Check the invoice date and rate.`);
    else if (!GST_NOW.includes(r)) add('bad', `${r}% is not a GST rate. Valid rates are 5%, 18% and 40% (0% for exempt supplies).`);
    else if (guide.kind === 'none') add('warn', `GST charged here is unusual. ${guide.note}`);
    else if (guide.kind === 'standard' && r !== 18 && r !== 5) add('warn', `${guide.note} ${r}% does not match.`);
    else if (guide.kind === 'standard' && r === 5) add('info', '5% applies to some goods and food; services are normally 18%. Confirm with the invoice.');
    else add('ok', `${r}% is a normal rate for this kind of payment.`);
    if (vendor !== undefined) {
      if (!gstin) add('warn', 'No GSTIN on this vendor. Unregistered vendors (turnover under the threshold) cannot charge GST - ask for their GSTIN and the GST invoice number.');
      else if (!validGstin(gstin)) add('warn', `The vendor's GSTIN "${gstin}" is not in the right format (15 characters).`);
    }
    if (billedGst != null && billedGst !== '' && Math.abs(Number(billedGst) - gst) > 1) add('bad', `The invoice shows ₹${Math.round(billedGst)} GST but ${r}% works out to ₹${Math.round(gst)}. One of them is wrong.`);
  } else if (guide.kind === 'standard' && a >= 5000) {
    add('info', `No GST on this bill. ${guide.note} If the vendor is GST-registered, ask for a GST invoice.`);
  } else if (guide.kind === 'none') add('ok', guide.note);
  return { base, gst, total, guide, msgs, hasGst };
}
