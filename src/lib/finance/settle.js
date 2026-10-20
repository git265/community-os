// Settling bills: used by the online-payment settler (after a verified webhook) so "mark paid + receipt + credit used" lives in one place.
// Works on raw storage on purpose - this is the step the Spring Boot webhook performs on the server, with no browser user involved.
import { storage, COLLECTIONS as C } from '../storage/index.js';
import { logEvent } from '../audit/auditLog.js';
import { applyCredits, todayIso, r2 } from './rules.js';
import { trailFor } from '../storage/trail.js';
import { getSchema } from '../security/principal.js';

export async function settleDues({ dueIds, unit, useCredit = false, mode, reference, paidOn = todayIso(), paidBy = '', actor = 'System · payment gateway' }) {
  const ids = [...new Set(dueIds)];
  if (useCredit && unit) await applyCredits({ units: [unit], only: ids, actor });
  const open = (await storage.list(C.DUES)).filter((d) => ids.includes(d.id) && !['Paid', 'Cancelled'].includes(d.status)); // already-paid bills are skipped: safe to run twice
  const stamp = new Date().toISOString();
  const paid = open.map((d) => { const n = { ...d, status: 'Paid', paymentMode: mode, paymentRef: reference || '—', paidAt: paidOn, paidBy, receiptNo: `RCT-${String(d.shortId || '').replace(/^DUE-/, '') || Date.now()}`, lastUpdatedAt: stamp, lastUpdatedBy: actor }; return { ...n, ...trailFor(d, n, getSchema(C.DUES), stamp, actor) }; });
  if (paid.length) {
    await storage.putMany(C.DUES, paid);
    await logEvent({ who: actor, what: 'Billing & Finance', action: 'Update', unit, summary: `${paid.length} bill(s) paid online (${mode}, ref ${reference}) · ${r2(paid.reduce((n, d) => n + Number(d.amount), 0))}` });
    window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.DUES } }));
  }
  return paid;
}
