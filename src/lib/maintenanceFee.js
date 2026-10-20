// Publishing the maintenance fee: one Dues row (category Maintenance) per unit, with the editable "Maintenance fee" notice rendered for it.
import { uuid } from './uuid.js';
import { storage, COLLECTIONS } from './storage/index.js';
import { nextShortId } from './storage/secureStorage.js';
import { logEvent } from './audit/auditLog.js';
import { chargeFor, billedToOf, applyCredits } from './finance/rules.js';

export const DEFAULT_FEE_BODY = 'Dear owner of {{UNIT}},\n\nThe maintenance fee for {{MONTH}} is {{AMOUNT}}, payable by {{DUE_DATE}}.\nPlease pay it from the portal (Billing & Finance → Dues) or at the office.\n\nThank you,\n{{SOCIETY_NAME}} Management';
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const dmy = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export async function maintenanceTemplate() {
  return (await storage.list(COLLECTIONS.NOTICE_TEMPLATES)).find((t) => t.appliesTo === 'Maintenance fee');
}

const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setMonth(d.getMonth() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** A yearly fee split into equal quarterly instalments (the last one carries the rounding). */
export function instalments(total, firstDue, n = 4) {
  const each = Math.floor(Number(total) / n);
  return Array.from({ length: n }, (_, i) => ({ no: i + 1, of: n, amount: i === n - 1 ? Number(total) - each * (n - 1) : each, dueDate: addMonths(firstDue, i * (12 / n)) }));
}
const isYear = (period) => /^FY /.test(period);

/** The units a fee would be raised for, with the amount each pays, how they pay (yearly / quarterly) and whether the period is already billed. */
export async function previewMaintenanceFee({ period, amount, overrides = {}, basis = 'Flat per unit', blockOverrides = {} }) {
  const [props, dues] = await Promise.all([storage.list(COLLECTIONS.PROPERTIES), storage.list(COLLECTIONS.DUES)]);
  // units already billed for this period (a Set: 2,000 units x 24,000 dues must not be compared pair by pair)
  const billed = new Set(dues.filter((d) => d.category === 'Maintenance' && (d.billedMonth === period || d.planGroup === period)).map((d) => d.unit));
  return props.filter((p) => p.unit).map((p) => {
    const { amount: amt, missing } = chargeFor(p, { basis, rate: amount, byType: overrides, byBlock: blockOverrides });
    const exists = billed.has(p.unit);
    return { unit: p.unit, type: p.type, zone: p.zone, amount: amt, missing, exists, quarterly: isYear(period) && p.maintenancePlan === 'Quarterly', ...billedToOf(p) };
  });
}

export async function publishMaintenanceFee({ period, amount, overrides = {}, basis, blockOverrides = {}, dueDate, body, actor = 'Billing' }) {
  const rows = (await previewMaintenanceFee({ period, amount, overrides, basis, blockOverrides })).filter((r) => !r.exists && r.amount > 0);
  if (!rows.length) return { created: 0, total: 0, units: 0 };
  const society = (await storage.list(COLLECTIONS.MERGE_FIELDS)).find((m) => m.token === '{{SOCIETY_NAME}}')?.defaultValue || 'Community';
  const tpl = body || (await maintenanceTemplate())?.body || DEFAULT_FEE_BODY;
  const now = new Date().toISOString();
  let seq = Number(String(await nextShortId(COLLECTIONS.DUES)).replace(/^\D+-/, ''));
  let total = 0; let created = 0;
  const batch = [];
  for (const r of rows) {
    const parts = r.quarterly ? instalments(r.amount, dueDate) : [{ no: 1, of: 1, amount: r.amount, dueDate }];
    for (const part of parts) {
      const label = r.quarterly ? `${period} · Q${part.no}` : period;
      const map = { '{{UNIT}}': r.unit, '{{AMOUNT}}': inr(part.amount), '{{MONTH}}': label, '{{DUE_DATE}}': dmy(part.dueDate), '{{SOCIETY_NAME}}': society, '{{UTILITY_TYPE}}': 'maintenance' };
      const notice = Object.entries(map).reduce((x, [k, v]) => x.split(k).join(v), tpl);
      batch.push({
        id: uuid(), shortId: `DUE-${String(seq++).padStart(4, '0')}`, recVersion: 1, unit: r.unit, category: 'Maintenance', amount: part.amount, billedMonth: label, dueDate: part.dueDate, status: 'Unpaid', notice, billTo: r.billTo, billedTo: r.billedTo,
        ...(isYear(period) ? { planGroup: period, plan: r.quarterly ? 'Quarterly' : 'Yearly', instalment: `${part.no} of ${part.of}`, annualFee: r.amount } : {}),
        recordCreatedAt: now, recordCreatedBy: actor, lastUpdatedAt: now, lastUpdatedBy: actor,
      });
      created += 1;
    }
    total += r.amount;
  }
  await storage.putMany(COLLECTIONS.DUES, batch); // one write for every unit
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Create', summary: `Published maintenance fee for ${period}: ${rows.length} units (${rows.filter((r) => r.quarterly).length} paying quarterly), ${created} bills, ${inr(total)} in all, first payable by ${dmy(dueDate)}` });
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.DUES } }));
  await applyCredits({ units: rows.map((r) => r.unit), actor }); // advances and credit notes pay the new bills first
  return { created, total, units: rows.length };
}

/** An unpaid yearly bill -> four quarterly instalments (the owner asked to pay quarterly). The yearly bill is replaced; nothing has been paid on it. */
export async function splitIntoInstalments(due, { actor = 'Billing' } = {}) {
  if (due.status === 'Paid' || due.plan === 'Quarterly' || !isYear(due.billedMonth || '')) return { error: 'Only an unpaid yearly bill can be split.' };
  const all = await storage.list(COLLECTIONS.DUES);
  let seq = Number(String(await nextShortId(COLLECTIONS.DUES)).replace(/^\D+-/, ''));
  const now = new Date().toISOString();
  const parts = instalments(due.annualFee || due.amount, due.dueDate);
  const tpl = (await maintenanceTemplate())?.body || DEFAULT_FEE_BODY;
  const society = (await storage.list(COLLECTIONS.MERGE_FIELDS)).find((m) => m.token === '{{SOCIETY_NAME}}')?.defaultValue || 'Community';
  // keep the original bill number on the first instalment so references to it still work
  for (const part of parts) {
    const label = `${due.billedMonth} · Q${part.no}`;
    const map = { '{{UNIT}}': due.unit, '{{AMOUNT}}': inr(part.amount), '{{MONTH}}': label, '{{DUE_DATE}}': dmy(part.dueDate), '{{SOCIETY_NAME}}': society, '{{UTILITY_TYPE}}': 'maintenance' };
    const notice = Object.entries(map).reduce((x, [k, v]) => x.split(k).join(v), tpl);
    const base = { ...due, amount: part.amount, billedMonth: label, dueDate: part.dueDate, planGroup: due.billedMonth, plan: 'Quarterly', instalment: `${part.no} of ${part.of}`, annualFee: due.annualFee || due.amount, notice, lastUpdatedAt: now, lastUpdatedBy: actor };
    if (part.no === 1) await storage.put(COLLECTIONS.DUES, base);
    else await storage.put(COLLECTIONS.DUES, { ...base, id: uuid(), shortId: `DUE-${String(seq++).padStart(4, '0')}`, recVersion: 1, reminderSentAt: '', reminderCount: 0, recordCreatedAt: now, recordCreatedBy: actor });
  }
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Update', recordId: due.id, recordShortId: due.shortId, unit: due.unit, summary: `Yearly maintenance bill ${due.shortId} (${due.billedMonth}) split into 4 quarterly instalments` });
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.DUES } }));
  void all;
  return { ok: true };
}
