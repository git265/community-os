// Input tax credit check: has each vendor really filed the GST we are claiming? Three layers, cheapest first:
//  1. the vendor's GSTIN is present and valid (format + the official check character), computed here;
//  2. the invoice has what the GST portal matches on (bill number, date, tax amount);
//  3. the invoice shows in the GSTR-2B statement, asked of the GST gateway (simulated until a real provider is connected).
// Runs on demand (Billing -> Input credit -> Check now) and, if switched on, once a day in the background.
import { storage, COLLECTIONS as C } from '../storage/index.js';
import { gstGateway, applyGstSettings } from './gstGateway.js';
import { logEvent } from '../audit/auditLog.js';

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function validateGstin(g) {
  const s = String(g || '').trim().toUpperCase();
  if (!s) return { ok: false, reason: 'No GSTIN on the vendor record' };
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return { ok: false, reason: 'GSTIN is not in the right format (15 characters)' };
  let sum = 0;
  for (let i = 0; i < 14; i += 1) { const p = CHARS.indexOf(s[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  const check = CHARS[(36 - (sum % 36)) % 36];
  return check === s[14] ? { ok: true, reason: '' } : { ok: false, reason: 'GSTIN check character does not match: likely a typing mistake' };
}

export const ITC = { none: 'Not checked', ok: 'Verified', gstin: 'Check vendor GSTIN', details: 'Invoice details missing', missing: 'Not found in GSTR-2B', na: 'Not applicable' };

/** Is this payment one that carries input credit we would claim? */
export const carriesCredit = (l) => l.type === 'Debit' && Number(l.gstAmount) > 0 && !l.reversalOf;

/** The result for one payment line. Pure except for the gateway call. */
export async function checkLine(line, vendors, { registered = true } = {}) {
  if (!registered) return { itcStatus: ITC.na, itcNote: 'The society is not registered for GST, so no input credit is claimed.' };
  const v = (vendors || []).find((x) => x.name === line.vendor);
  const g = validateGstin(v?.gstin);
  if (!line.vendor) return { itcStatus: ITC.details, itcNote: 'No vendor chosen on this payment.' };
  if (!g.ok) return { itcStatus: ITC.gstin, itcNote: g.reason };
  if (!String(line.invoiceNo || line.billNo || '').trim()) return { itcStatus: ITC.details, itcNote: 'Add the vendor’s invoice number so it can be matched on the GST portal.' };
  const r = await gstGateway().lookupInvoice({ gstin: v.gstin, invoiceNo: line.invoiceNo || line.billNo, date: line.date, gstAmount: line.gstAmount });
  if (r.found && r.amountMatches === false) return { itcStatus: ITC.details, itcNote: 'The vendor filed this invoice with a different tax amount. Ask them to correct it.' };
  return r.found ? { itcStatus: ITC.ok, itcNote: r.filedOn ? `Vendor filed on ${r.filedOn}` : 'Invoice found in the vendor’s filing' } : { itcStatus: ITC.missing, itcNote: 'The vendor has not shown this invoice in their GST filing. Ask them to file it, or the credit may be lost.' };
}

/** Check payment lines and save the result on each. only: 'pending' (never checked or needing another look) or 'all'. Returns counts. */
export async function runItcChecks({ actor = 'System · background check', only = 'all', put = (row) => storage.put(C.LEDGER, row) } = {}) {
  const [ledger, vendors, settings] = await Promise.all([storage.list(C.LEDGER), storage.list(C.VENDORS), storage.list(C.TAX_SETTINGS)]);
  const registered = (settings[0]?.registered || 'No') === 'Yes';
  applyGstSettings(settings[0] || {});
  const todo = ledger.filter((l) => carriesCredit(l) && (only === 'all' || !l.itcStatus || [ITC.none, ITC.missing, ITC.gstin, ITC.details].includes(l.itcStatus)));
  const now = new Date().toISOString(); const res = { checked: 0, ok: 0, attention: 0 };
  for (const l of todo) {
    const r = await checkLine(l, vendors, { registered });
    await put({ ...l, ...r, itcCheckedAt: now });
    res.checked += 1; if (r.itcStatus === ITC.ok || r.itcStatus === ITC.na) res.ok += 1; else res.attention += 1;
  }
  if (res.checked) await logEvent({ who: actor, what: 'Billing & Finance', action: 'Update', summary: `GST input credit check: ${res.checked} payment(s) checked, ${res.attention} need attention` });
  return res;
}

/** Background: once a day, only when the society is registered and has switched the automatic check on. */
export async function runAutoItc() {
  const s = (await storage.list(C.TAX_SETTINGS))[0];
  if (!s || s.registered !== 'Yes' || s.itcAuto === false) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (String(s.itcLastRun || '').slice(0, 10) === today) return null;
  const res = await runItcChecks({ only: 'pending' });
  await storage.put(C.TAX_SETTINGS, { ...s, itcLastRun: new Date().toISOString() });
  return res;
}
