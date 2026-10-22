// Finance rules in one place: charge rules (flat / per sq ft / per bedroom), late fees, special levies, credit notes and advances,
// payment plans, defaulters + notices, the amenity block for defaulters, approval limit and recurring bills.
// These are the pieces a Spring Boot service would own; they read and write below the permission layer (like amenityServer.js),
// so every caller is a screen that already checked the person may manage billing.
import { storage, COLLECTIONS as C } from '../storage/index.js';
import { nextShortId } from '../storage/secureStorage.js';
import { uuid } from '../uuid.js';
import { logEvent } from '../audit/auditLog.js';
import { notifyMany } from '../notify.js';
import { recordPayment } from '../paymentEngine.js';
import { fmtDate } from '../locale.js';

export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
export const dmy = (s) => fmtDate(s);
export const addMonthsIso = (iso, n) => { const d = new Date(`${iso}T00:00:00`); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const addDaysIso = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
const changed = (collection) => window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection } }));

/** Hand out the next short ids (DUE-0123 ...) for a batch without a read per row. */
async function seqer(collection) {
  const first = String(await nextShortId(collection));
  const m = /^(.*?)(\d+)$/.exec(first);
  let n = Number(m[2]);
  return () => `${m[1]}${String(n++).padStart(m[2].length, '0')}`;
}
const stamp = (row, actor, shortId) => {
  const now = new Date().toISOString();
  return { id: uuid(), shortId, recVersion: 1, ...row, recordCreatedAt: now, recordCreatedBy: actor, lastUpdatedAt: now, lastUpdatedBy: actor };
};
export async function financeSettings() { return (await storage.list(C.FINANCE_SETTINGS))[0] || {}; }
const society = async () => (await storage.list(C.MERGE_FIELDS)).find((m) => m.token === '{{SOCIETY_NAME}}')?.defaultValue || 'Community';
const fill = (t, map) => Object.entries(map).reduce((x, [k, v]) => x.split(k).join(v), t || '');

/* ------------------------------------------------------------ charge rules -- */

export const BASES = ['Flat per unit', 'Per sq ft', 'Per bedroom'];
/**
 * What one unit pays under a rule { basis, rate, byType: {Villa: n}, byBlock: {'Block A': n} }.
 * The rate can be replaced for a property type, and a block's rate wins over the type's. `missing` = the unit has no area / bedrooms recorded.
 */
export function chargeFor(prop, rule) {
  const o = rule.byBlock?.[prop.zone] ?? rule.byType?.[prop.type];
  const rate = o !== undefined && o !== '' && o !== null ? Number(o) : Number(rule.rate);
  if (!(rate >= 0)) return { amount: 0, missing: false };
  if (rule.basis === 'Per sq ft') { const a = Number(prop.areaSqft) || 0; return { amount: r2(rate * a), missing: !a }; }
  if (rule.basis === 'Per bedroom') { const b = Number(prop.bedrooms) || 0; return { amount: r2(rate * b), missing: !b }; }
  return { amount: r2(rate), missing: false };
}
/** Who a unit's bills are addressed to. */
export const billedToOf = (prop) => (prop.billTo === 'Tenant' && prop.tenant ? { billTo: 'Tenant', billedTo: prop.tenant } : { billTo: 'Owner', billedTo: prop.owner || '' });

export function inScope(prop, scope) {
  if (!scope || scope.kind === 'All') return true;
  if (scope.kind === 'Block') return (scope.values || []).includes(prop.zone);
  if (scope.kind === 'Type') return (scope.values || []).includes(prop.type);
  return true;
}
export const scopeText = (scope) => (!scope || scope.kind === 'All' ? 'All units' : `${scope.kind === 'Block' ? 'Blocks' : 'Types'}: ${(scope.values || []).join(', ')}`);

/* ------------------------------------------------------------ special levies -- */

export async function previewLevy({ rule, scope }) {
  const props = (await storage.list(C.PROPERTIES)).filter((p) => p.unit && inScope(p, scope));
  return props.map((p) => ({ unit: p.unit, type: p.type, zone: p.zone, ...chargeFor(p, rule), ...billedToOf(p) }));
}

export async function raiseLevy({ name, purpose, fund, rule, scope, dueDate, actor = 'Billing' }) {
  const rows = (await previewLevy({ rule, scope })).filter((r) => r.amount > 0);
  if (!rows.length) return { error: 'No unit would be charged - check the amount and who it applies to' };
  const levyId = uuid();
  const lvSeq = await seqer(C.LEVIES);
  const total = r2(rows.reduce((s, r) => s + r.amount, 0));
  const levy = stamp({ id: levyId, name, purpose, fund: fund || '', basis: rule.basis, rate: Number(rule.rate), byType: rule.byType || {}, byBlock: rule.byBlock || {}, scope: scopeText(scope), dueDate, units: rows.length, total }, actor, lvSeq());
  const next = await seqer(C.DUES);
  const soc = await society();
  const body = `Dear owner of {{UNIT}},\n\nA one-time levy of {{AMOUNT}} has been raised for ${name} (${purpose}), payable by {{DUE_DATE}}.\nPlease pay it from the portal (Billing & Finance → Dues) or at the office.\n\nThank you,\n{{SOCIETY_NAME}} Management`;
  const dues = rows.map((r) => stamp({ unit: r.unit, category: 'Special levy', amount: r.amount, billedMonth: name, dueDate, status: 'Unpaid', levyId, billTo: r.billTo, billedTo: r.billedTo, notice: fill(body, { '{{UNIT}}': r.unit, '{{AMOUNT}}': inr(r.amount), '{{DUE_DATE}}': dmy(dueDate), '{{SOCIETY_NAME}}': soc }) }, actor, next()));
  await storage.put(C.LEVIES, levy);
  await storage.putMany(C.DUES, dues);
  const penaltyLine = (await import('../billText.js')).penaltyRule(await lateFeeSettings(), 'Special levy');
  await notifyMany(rows.map((r) => ({ event: 'payment_reminder', title: `Special levy: ${name}`, body: `${inr(r.amount)} is payable by ${dmy(dueDate)} for ${purpose}.\n${penaltyLine}`, kind: 'payment_reminder', by: actor, toUnit: r.unit })));
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Create', summary: `Special levy "${name}" raised: ${rows.length} units, ${inr(total)} in all, payable by ${dmy(dueDate)}${fund ? `, into fund ${fund}` : ''}` });
  changed(C.DUES); changed(C.LEVIES);
  await applyCredits({ units: rows.map((r) => r.unit), actor }); // advances / credit notes pay off the new bill first
  return { levy, created: rows.length, total };
}

/** Raised / collected / pending for each levy. */
export function levyProgress(levies, dues) {
  const by = new Map();
  dues.filter((d) => d.levyId).forEach((d) => {
    const x = by.get(d.levyId) || { raised: 0, collected: 0, units: 0, paidUnits: 0 };
    const gross = Number(d.grossAmount) || Number(d.amount) || 0;
    x.raised += gross; x.units += 1;
    if (d.status === 'Paid') { x.collected += gross; x.paidUnits += 1; } else x.collected += gross - (Number(d.amount) || 0);
    by.set(d.levyId, x);
  });
  return levies.map((l) => { const x = by.get(l.id) || { raised: 0, collected: 0, units: 0, paidUnits: 0 }; return { ...l, ...x, pending: r2(x.raised - x.collected) }; });
}

/* ------------------------------------------------------------------ late fees -- */

export const LATE_KINDS = ['Percent per month', 'Fixed per month'];
/** Bill types a late-fee rule can be set for. '*' = every other bill. */
export const LATE_CATEGORIES = ['Maintenance', 'Sinking fund', 'Corpus fund', 'Water', 'DG', 'Special levy', 'Amenity booking', 'Other'];
const cleanRule = (r, i = 0) => ({ id: r.id || `r${i}`, appliesTo: r.appliesTo || '*', kind: r.kind === 'Fixed per month' ? 'Fixed per month' : 'Percent per month', value: Number(r.value) || 0, grace: Math.max(0, Number(r.grace) || 0), maxMonths: Number(r.maxMonths) || 0 });
/** The rule that governs a bill: the one set for its category, else the "all other bills" rule. */
export function ruleFor(s, category) {
  const rules = s?.rules || (s ? [{ ...s, appliesTo: '*' }] : []);
  const hit = rules.find((r) => r.appliesTo === category) || rules.find((r) => !r.appliesTo || r.appliesTo === '*');
  return hit && hit.value > 0 ? hit : null;
}
export async function lateFeeSettings() {
  const r = await financeSettings();
  let rules = [];
  try { rules = JSON.parse(r.lateFeeRules || '[]'); } catch { rules = []; }
  rules = Array.isArray(rules) ? rules.map(cleanRule) : [];
  // communities set up before per-bill rules keep their single rule as the "all other bills" rule
  if (!rules.length && Number(r.lateFeeValue) > 0) rules = [cleanRule({ id: 'default', appliesTo: '*', kind: r.lateFeeKind, value: r.lateFeeValue, grace: r.lateFeeGraceDays, maxMonths: r.lateFeeMaxMonths })];
  const first = rules.find((x) => x.appliesTo === '*') || rules[0] || cleanRule({});
  return { enabled: !!r.lateFeeEnabled, auto: !!r.lateFeeAuto, rules, kind: first.kind, value: first.value, grace: first.grace, maxMonths: first.maxMonths };
}
const feeFor = (rule, d) => { const base = Number(d.grossAmount) || Number(d.amount) || 0; return rule.kind === 'Fixed per month' ? r2(rule.value) : r2((base * rule.value) / 100); };
/** Late fees that are due now and not yet charged. One fee per overdue bill per month; fees never earn fees. Each bill follows the rule for its category. */
export function planLateFees(dues, s, asOf = todayIso()) {
  const have = new Set(dues.filter((d) => d.lateFeeFor).map((d) => `${d.lateFeeFor}#${d.lateFeeNo}`));
  const out = [];
  for (const d of dues) {
    if (d.status === 'Paid' || d.category === 'Late fee' || !d.dueDate || !(Number(d.amount) > 0) || !d.unit) continue;
    const rule = ruleFor(s, d.category);
    if (!rule) continue;
    const start = addDaysIso(d.dueDate, rule.grace);
    const cap = rule.maxMonths > 0 ? rule.maxMonths : 36;
    for (let k = 1; k <= cap; k += 1) {
      if (asOf <= addMonthsIso(start, k - 1)) break;
      if (have.has(`${d.id}#${k}`)) continue;
      const amount = feeFor(rule, d);
      if (amount > 0) out.push({ due: d, no: k, amount, rule });
    }
  }
  return out;
}
/** What a bill really costs today: the bill, late fees already added as their own bills (unpaid), and late fees accrued but not yet added. */
export function finalDue(due, allDues, s, today = todayIso()) {
  const base = r2(Number(due.amount) || 0);
  if (!due || due.status === 'Paid' || due.category === 'Late fee') return { base, charged: 0, pending: 0, total: base, months: 0, per: 0 };
  const charged = r2(allDues.filter((x) => x.lateFeeFor === due.id && !['Paid', 'Cancelled'].includes(x.status)).reduce((n, x) => n + (Number(x.amount) || 0), 0));
  const rule = ruleFor(s, due.category);
  const planned = rule && s?.enabled !== false ? planLateFees([{ ...due, id: due.id }].concat(allDues.filter((x) => x.lateFeeFor === due.id)), s, today).filter((p) => p.due.id === due.id) : [];
  const pending = r2(planned.reduce((n, p) => n + p.amount, 0));
  return { base, charged, pending, total: r2(base + charged + pending), months: planned.length, per: planned[0]?.amount || 0 };
}
export async function applyLateFees({ asOf = todayIso(), actor = 'Billing', auto = false, only = null } = {}) {
  const s = await lateFeeSettings();
  const dues = await storage.list(C.DUES);
  const plan = planLateFees(dues, s, asOf).filter((p) => !only || p.due.id === only);
  if (!plan.length) return { created: 0, total: 0, rows: [] };
  const next = await seqer(C.DUES);
  const rows = plan.map(({ due, no, amount }) => stamp({ unit: due.unit, category: 'Late fee', amount, billedMonth: `Late fee · ${due.billedMonth || due.shortId} · month ${no}`, dueDate: asOf, status: 'Unpaid', lateFeeFor: due.id, lateFeeNo: no, billTo: due.billTo || 'Owner', billedTo: due.billedTo || '', notice: `Late fee for ${due.category} bill ${due.shortId || ''} (${due.billedMonth || ''}), unpaid after ${dmy(due.dueDate)}.` }, actor, next()));
  await storage.putMany(C.DUES, rows);
  const total = r2(rows.reduce((n, r) => n + r.amount, 0));
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Create', summary: `Late fees ${auto ? 'added automatically' : 'applied'}: ${rows.length} fee${rows.length === 1 ? '' : 's'}, ${inr(total)} on ${new Set(rows.map((r) => r.unit)).size} unit(s)` });
  changed(C.DUES);
  return { created: rows.length, total, rows };
}
/** Remove a unit's unpaid late fees (waiver). */
export async function waiveLateFees(unit, actor = 'Billing') {
  const fees = (await storage.list(C.DUES)).filter((d) => d.unit === unit && d.category === 'Late fee' && !['Paid', 'Cancelled'].includes(d.status));
  for (const f of fees) await storage.remove(C.DUES, f.id);
  if (fees.length) { await logEvent({ who: actor, what: 'Billing & Finance', action: 'Delete', unit, summary: `Late fees waived for ${unit}: ${fees.length} fee(s), ${inr(fees.reduce((n, f) => n + f.amount, 0))}` }); changed(C.DUES); }
  return fees.length;
}
export async function runAutoLateFees() {
  const s = await lateFeeSettings();
  if (!s.enabled || !s.auto) return 0;
  return (await applyLateFees({ actor: 'System · late fees', auto: true })).created;
}

/* --------------------------------------------- credits, credit notes, advances -- */

export const creditBalance = (rows, unit) => r2(rows.filter((r) => r.unit === unit).reduce((n, r) => n + (r.type === 'Credit' ? 1 : -1) * (Number(r.amount) || 0), 0));
const FINANCE_KINDS = ['Advance', 'Credit note', 'Applied'];
/** Credit the finance team holds for each unit (advances and credit notes, less what bills used). Amenity refunds sit in the same account but are kept for amenity bookings, so they are not counted here. */
export async function creditBalances() {
  const by = new Map();
  (await storage.list(C.UNIT_CREDITS)).filter((r) => FINANCE_KINDS.includes(r.kind)).forEach((r) => by.set(r.unit, r2((by.get(r.unit) || 0) + (r.type === 'Credit' ? 1 : -1) * (Number(r.amount) || 0))));
  return by;
}
async function creditRows(list, actor) {
  const next = await seqer(C.UNIT_CREDITS);
  const rows = list.map((r) => stamp({ date: todayIso(), ...r, amount: r2(r.amount) }, actor, next()));
  await storage.putMany(C.UNIT_CREDITS, rows);
  changed(C.UNIT_CREDITS);
  return rows;
}

/** Credit notes: a different amount per unit. 'credit' keeps the money on the unit's account for its next bill; 'refund' pays it back from the bank. */
export async function issueCreditNotes({ rows, reason, how = 'credit', account, mode = 'Bank transfer', ref = '', date = todayIso(), actor = 'Billing' }) {
  const list = rows.filter((r) => r.unit && Number(r.amount) > 0);
  if (!list.length) return { error: 'Enter an amount for at least one unit' };
  if (!String(reason || '').trim()) return { error: 'Say why the credit is given' };
  if (String(reason).trim().length < 5) return { error: 'Give a clearer reason (at least a few words) - it appears on the unit\'s statement' };
  if (date > todayIso()) return { error: 'The date cannot be in the future' };
  const seen = new Set();
  for (const r of list) { if (seen.has(r.unit)) return { error: `${r.unit} appears twice - combine it into one line` }; seen.add(r.unit); if (Math.round(Number(r.amount) * 100) !== Number(r.amount) * 100) return { error: `${r.unit}: use at most two decimal places` }; }
  // Cap each note at what the unit was billed in total, and refuse an exact repeat of a recent note.
  const billed = new Map(); (await storage.list(C.DUES)).forEach((d) => billed.set(d.unit, r2((billed.get(d.unit) || 0) + (Number(d.amount) || 0))));
  const prior = (await storage.list(C.UNIT_CREDITS)).filter((x) => x.kind === 'Credit note');
  for (const r of list) {
    if (billed.has(r.unit) && Number(r.amount) > billed.get(r.unit)) return { error: `${r.unit}: ${inr(r.amount)} is more than the ${inr(billed.get(r.unit))} billed to this unit` };
    if (prior.some((x) => x.unit === r.unit && Number(x.amount) === Number(r.amount) && String(x.reason) === `Credit note: ${reason}`)) return { error: `${r.unit}: the same credit note (${inr(r.amount)}, same reason) was already issued` };
  }
  if (how === 'refund') {
    if (!account) return { error: 'Choose the bank account the refund is paid from' };
    if (!String(ref || '').trim() && mode !== 'Cash') return { error: 'Enter the UTR / cheque number of the refund' };
    const props = await storage.list(C.PROPERTIES);
    for (const r of list) {
      const res = await recordPayment({ area: 'Dues', type: 'Debit', amount: r.amount, account, date, mode, ref, vendor: props.find((p) => p.unit === r.unit)?.owner || r.unit, description: `Refund · ${reason} · ${r.unit}`, category: 'Refund', sourceType: 'creditNote', sourceId: `creditnote:${uuid()}`, unit: r.unit });
      if (res.error) return { error: `${r.unit}: ${res.error}` };
    }
  } else {
    await creditRows(list.map((r) => ({ unit: r.unit, type: 'Credit', amount: r.amount, reason: `Credit note: ${reason}`, kind: 'Credit note' })), actor);
  }
  const total = r2(list.reduce((n, r) => n + Number(r.amount), 0));
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Create', summary: `Credit notes (${how === 'refund' ? 'refunded' : 'kept as credit for the next bill'}): ${list.length} unit(s), ${inr(total)} - ${reason}` });
  if (how !== 'refund') await applyCredits({ units: list.map((r) => r.unit), actor });
  return { created: list.length, total };
}

/** Money received before a bill exists (or more than was billed): booked in the ledger and held as credit on the unit. */
export async function receiveAdvance({ unit, amount, account, mode = 'Bank transfer', ref = '', date = todayIso(), actor = 'Billing' }) {
  if (!unit) return { error: 'Choose the unit' };
  const res = await recordPayment({ area: 'Dues', type: 'Credit', amount, account, date, mode, ref, description: `Advance received · ${unit}`, category: 'Advance', sourceType: 'advance', sourceId: `advance:${uuid()}`, unit, vendor: '' });
  if (res.error) return res;
  await creditRows([{ unit, type: 'Credit', amount, reason: `Advance received (${mode}${ref ? ` ${ref}` : ''})`, kind: 'Advance', date }], actor);
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Create', unit, summary: `Advance of ${inr(amount)} received from ${unit} (${mode})` });
  await applyCredits({ units: [unit], actor });
  return { ok: true };
}

/** Use each unit's credit on its unpaid bills, oldest first. A bill is cleared when the credit covers it, otherwise reduced. */
export async function applyCredits({ units = null, only = null, actor = 'Billing' } = {}) {
  const bal = await creditBalances();
  const dues = await storage.list(C.DUES);
  const today = todayIso();
  const updates = []; const debits = [];
  const byUnit = new Map();
  dues.forEach((d) => { if (!['Paid', 'Cancelled'].includes(d.status) && Number(d.amount) > 0 && d.unit && (!only || only.includes(d.id))) { if (!byUnit.has(d.unit)) byUnit.set(d.unit, []); byUnit.get(d.unit).push(d); } });
  for (const [unit, list] of byUnit) {
    if (units && !units.includes(unit)) continue;
    let credit = bal.get(unit) || 0;
    if (!(credit > 0)) continue;
    list.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    for (const d of list) {
      if (!(credit > 0.004)) break;
      const use = Math.min(credit, Number(d.amount));
      credit = r2(credit - use);
      const full = use >= Number(d.amount) - 0.004;
      const gross = Number(d.grossAmount) || Number(d.amount);
      updates.push({ ...d, grossAmount: gross, creditApplied: r2((Number(d.creditApplied) || 0) + use), amount: full ? Number(d.amount) : r2(Number(d.amount) - use), ...(full ? { status: 'Paid', paymentMode: 'Unit credit', paymentRef: 'CREDIT', paidAt: today, paidBy: actor, receiptNo: `RCT-${String(d.shortId || '').replace(/^DUE-/, '') || Date.now()}` } : {}), lastUpdatedAt: new Date().toISOString(), lastUpdatedBy: actor });
      debits.push({ unit, type: 'Debit', amount: use, reason: `${full ? 'Paid' : 'Part-paid'} bill ${d.shortId || ''} from credit`, kind: 'Applied', billNo: d.shortId || '' });
    }
  }
  if (!updates.length) return 0;
  await storage.putMany(C.DUES, updates);
  await creditRows(debits, actor);
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Update', summary: `Unit credit used on ${updates.length} bill(s) for ${new Set(debits.map((x) => x.unit)).size} unit(s)` });
  changed(C.DUES);
  return updates.length;
}

/* ---------------------------------------------------------------- payment plans -- */

/** Split one unpaid bill into N equal instalments, one per month. The first keeps the bill's number; the others are new bills. */
export async function splitDue(due, { parts = 3, firstDue, everyMonths = 1, actor = 'Billing' } = {}) {
  const n = Math.round(Number(parts));
  if (due.status === 'Paid') return { error: 'This bill is already paid' };
  if (!(n >= 2 && n <= 24)) return { error: 'Choose 2 to 24 instalments' };
  if (due.plan === 'Instalments') return { error: 'This bill is already part of a payment plan' };
  const first = firstDue || due.dueDate || todayIso();
  const each = Math.floor((Number(due.amount) * 100) / n) / 100;
  const group = due.billedMonth || due.shortId;
  const next = await seqer(C.DUES);
  const now = new Date().toISOString();
  const rows = Array.from({ length: n }, (_, i) => {
    const amount = i === n - 1 ? r2(Number(due.amount) - each * (n - 1)) : each;
    const base = { ...due, amount, dueDate: addMonthsIso(first, i * everyMonths), billedMonth: `${group} · ${i + 1}/${n}`, planGroup: due.planGroup || group, plan: 'Instalments', instalment: `${i + 1} of ${n}`, reminderSentAt: '', reminderCount: 0, lastUpdatedAt: now, lastUpdatedBy: actor };
    delete base.grossAmount;
    return i === 0 ? base : { ...base, id: uuid(), shortId: next(), recVersion: 1, recordCreatedAt: now, recordCreatedBy: actor };
  });
  await storage.putMany(C.DUES, rows);
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Update', recordId: due.id, recordShortId: due.shortId, unit: due.unit, summary: `Bill ${due.shortId} (${inr(due.amount)}) split into ${n} monthly instalments from ${dmy(first)}` });
  changed(C.DUES);
  return { ok: true, parts: n };
}

/* ---------------------------------------------------------------- defaulters -- */

export const BUCKETS = ['1-30 days', '31-60 days', '61-90 days', '90+ days'];
export const bucketOf = (days) => (days <= 30 ? BUCKETS[0] : days <= 60 ? BUCKETS[1] : days <= 90 ? BUCKETS[2] : BUCKETS[3]);
/** One row per unit with overdue bills (due date passed, unpaid), oldest first / biggest first is the caller's sort. */
export function defaultersOf(dues, props, notices = [], asOf = todayIso()) {
  const byUnit = new Map();
  dues.forEach((d) => { if (!['Paid', 'Cancelled'].includes(d.status) && Number(d.amount) > 0 && d.dueDate && d.dueDate < asOf && d.unit) { if (!byUnit.has(d.unit)) byUnit.set(d.unit, []); byUnit.get(d.unit).push(d); } });
  const propBy = new Map(props.map((p) => [p.unit, p]));
  const lastBy = new Map();
  notices.forEach((n) => { const x = lastBy.get(n.unit); if (!x || String(n.sentAt) > String(x.sentAt)) lastBy.set(n.unit, n); });
  return [...byUnit.entries()].map(([unit, list]) => {
    const p = propBy.get(unit) || {};
    const oldest = list.reduce((m, d) => (d.dueDate < m ? d.dueDate : m), list[0].dueDate);
    const days = daysBetween(oldest, asOf);
    const who = billedToOf(p);
    return {
      unit, owner: who.billedTo || p.owner || '', billTo: who.billTo, block: p.zone || '', type: p.type || '', phone: who.billTo === 'Tenant' ? p.tenantPhone : p.ownerPhone,
      bills: list.length, amount: r2(list.reduce((n, d) => n + Number(d.amount), 0)), lateFees: r2(list.filter((d) => d.category === 'Late fee').reduce((n, d) => n + Number(d.amount), 0)),
      oldest, days, bucket: bucketOf(days), last: lastBy.get(unit) || null, ids: list.map((d) => d.id),
    };
  });
}

export const NOTICE_STAGES = {
  Reminder: 'Dear {{OWNER}},\n\nOur records show {{BILLS}} unpaid bill(s) for {{UNIT}} totalling {{AMOUNT}}, the oldest overdue by {{DAYS}} days.\nKindly clear the dues at the earliest from the portal (Billing & Finance → Dues) or at the office.\n\nThank you,\n{{SOCIETY_NAME}} Management',
  'Demand notice': 'Dear {{OWNER}},\n\nDEMAND NOTICE - {{UNIT}}\n\nDespite earlier reminders, {{AMOUNT}} ({{BILLS}} bill(s), oldest overdue by {{DAYS}} days) remains unpaid. Please pay the full amount within 15 days of this notice. Late fees may continue to apply and amenity booking may be withheld until the dues are cleared.\n\n{{SOCIETY_NAME}} Management',
  'Final notice': 'Dear {{OWNER}},\n\nFINAL NOTICE - {{UNIT}}\n\n{{AMOUNT}} ({{BILLS}} bill(s), oldest overdue by {{DAYS}} days) is still unpaid. If it is not cleared within 7 days, the association will proceed as permitted by its bye-laws and applicable law, including legal recovery.\n\n{{SOCIETY_NAME}} Management',
};
export function noticeText(stage, row, soc, body) {
  return fill(body || NOTICE_STAGES[stage] || NOTICE_STAGES.Reminder, { '{{OWNER}}': row.owner || 'owner', '{{UNIT}}': row.unit, '{{AMOUNT}}': inr(row.amount), '{{BILLS}}': String(row.bills), '{{DAYS}}': String(row.days), '{{SOCIETY_NAME}}': soc });
}
export async function sendNotices({ rows, stage, body, actor = 'Billing' }) {
  const soc = await society();
  const sentAt = new Date().toISOString();
  const texts = rows.map((r) => ({ r, text: noticeText(stage, r, soc, body) }));
  await notifyMany(texts.map(({ r, text }) => ({ event: 'payment_reminder', title: `${stage} · ${r.unit}`, body: text, kind: 'payment_reminder', by: actor, toUnit: r.unit })));
  const next = await seqer(C.DEMAND_NOTICES);
  await storage.putMany(C.DEMAND_NOTICES, texts.map(({ r, text }) => stamp({ unit: r.unit, stage, amount: r.amount, sentAt, sentBy: actor, body: text }, actor, next())));
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Create', summary: `${stage} sent to ${rows.length} unit(s), ${inr(rows.reduce((n, r) => n + r.amount, 0))} overdue in all` });
  changed(C.DEMAND_NOTICES);
  return { sent: rows.length, texts: texts.map((t) => ({ unit: t.r.unit, text: t.text })) };
}

/** The reason a unit may not book amenities because of overdue dues, or '' (used by the booking rules). */
export async function defaulterBlock(unit) {
  if (!unit || String(unit).startsWith('Association')) return '';
  const s = await financeSettings();
  if (!s.blockDefaulters) return '';
  const dues = (await storage.list(C.DUES)).filter((d) => d.unit === unit);
  const row = defaultersOf(dues, [])[0];
  if (!row) return '';
  if (row.days >= (Number(s.blockOverdueDays) || 0) && row.amount > (Number(s.blockOverdueAmount) || 0)) return `Booking is on hold for ${unit}: ${inr(row.amount)} has been overdue for ${row.days} days. Please clear the dues in Billing & Finance → Dues, then book again.`;
  return '';
}

/* ----------------------------------------------- approval limit (second approver) -- */

export async function approvalLimit() { return Number((await financeSettings()).approvalLimit) || 0; }
export async function submitPayRequest(payload, actor) {
  const next = await seqer(C.PAY_REQUESTS);
  const row = stamp({ description: payload.description || payload.sourceLabel || 'Payment', amount: payload.amount, vendor: payload.vendor || '', requestedBy: actor, status: 'Waiting', payload: JSON.stringify(payload) }, actor, next());
  await storage.put(C.PAY_REQUESTS, row);
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Create', recordShortId: row.shortId, summary: `Payment of ${inr(payload.amount)} to ${payload.vendor || '—'} is above the approval limit - waiting for a second approver` });
  changed(C.PAY_REQUESTS);
  return row;
}
/** A release has been paid: mark it Paid; a cultural expense whose releases now cover it in full becomes Paid too. */
export async function markReleasePaid(releaseId, how = '') {
  const rel = (await storage.list(C.RELEASES)).find((x) => x.id === releaseId);
  if (!rel) return;
  if (rel.status !== 'Paid') await storage.put(C.RELEASES, { ...rel, status: 'Paid' });
  if (!rel.expenseId) return;
  const exp = (await storage.list(C.CULTURAL_EXPENSES)).find((x) => x.id === rel.expenseId);
  if (!exp || exp.status === 'Paid') return;
  const mine = (await storage.list(C.RELEASES)).filter((x) => x.expenseId === exp.id && x.status !== 'Rejected');
  const paid = mine.filter((x) => x.status === 'Paid' || x.id === rel.id).reduce((n, x) => n + (Number(x.amount) || 0), 0);
  if (paid >= (Number(exp.amount) || 0) - 0.5) {
    await storage.put(C.CULTURAL_EXPENSES, { ...exp, status: 'Paid', paidBy: how || 'Paid in releases' });
    const { recomputeEventTotals } = await import('../culturalServer.js');
    await recomputeEventTotals(exp.eventId).catch(() => {});
  }
}

export async function decidePayRequest(req, approve, actor) {
  if (req.status !== 'Waiting') return { error: 'Already decided' };
  if (req.requestedBy === actor) return { error: 'A different person must approve this payment' };
  let out = { ok: true };
  if (approve) {
    const res = await recordPayment({ ...JSON.parse(req.payload), allowDuplicate: false });
    if (res.error) return { error: res.error };
    out = { ok: true, row: res.row };
    const pl = JSON.parse(req.payload);
    if ((pl.sourceType === 'release' || pl.sourceType === 'culturalRelease') && pl.sourceId) await markReleasePaid(pl.sourceId, `${pl.mode || ''} · ${pl.account || ''}${pl.ref ? ` · ${pl.ref}` : ''}`);
  }
  await storage.put(C.PAY_REQUESTS, { ...req, status: approve ? 'Approved' : 'Rejected', decidedBy: actor, lastUpdatedAt: new Date().toISOString(), lastUpdatedBy: actor });
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Update', recordShortId: req.shortId, summary: `Payment request ${req.shortId} (${inr(req.amount)}) ${approve ? 'approved and paid' : 'rejected'} by ${actor}` });
  changed(C.PAY_REQUESTS);
  return out;
}

/* -------------------------------------------------------------- recurring bills -- */

/** Raise this month's association bill for every active recurring bill that has not had one yet. Idempotent. */
export async function runRecurringBills({ now = new Date(), actor = 'System · recurring bills' } = {}) {
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const recs = (await storage.list(C.RECURRING_BILLS)).filter((r) => r.active !== false && r.lastMonth !== key && Number(r.amount) > 0);
  if (!recs.length) return 0;
  const next = await seqer(C.ASSOC_BILLS);
  const bills = recs.map((r) => {
    const day = Math.min(28, Math.max(1, Number(r.dayOfMonth) || 10));
    return stamp({ utility: r.utility || 'Other', location: r.location || 'Common area', provider: r.provider, period: key, billDate: `${key}-01`, dueDate: `${key}-${String(day).padStart(2, '0')}`, amount: Number(r.amount), notes: `Raised automatically from the recurring bill "${r.description}"`, recurringId: r.id }, actor, next());
  });
  await storage.putMany(C.ASSOC_BILLS, bills);
  await storage.putMany(C.RECURRING_BILLS, recs.map((r) => ({ ...r, lastMonth: key, lastUpdatedAt: new Date().toISOString(), lastUpdatedBy: actor })));
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Create', summary: `${bills.length} recurring bill(s) raised for ${key}` });
  changed(C.ASSOC_BILLS); changed(C.RECURRING_BILLS);
  return bills.length;
}

/* ------------------------------------------------------------ TDS and income -- */

export const TDS_SECTIONS = [
  { code: '194C', label: 'Contractor / service (194C)', rate: 2 },
  { code: '194J', label: 'Professional / technical fees (194J)', rate: 10 },
  { code: '194I', label: 'Rent (194I)', rate: 10 },
  { code: '194H', label: 'Commission / brokerage (194H)', rate: 2 },
  { code: '194Q', label: 'Purchase of goods (194Q)', rate: 0.1 },
  { code: '194A', label: 'Interest other than bank (194A)', rate: 10 },
];
export const INCOME_HEADS = ['Parking rent', 'Clubhouse / hall rent', 'Tower / antenna rent', 'Advertising / hoarding', 'Interest', 'Scrap sale', 'Penalty / fines', 'Other income'];
