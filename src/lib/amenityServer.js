// Server-side rules for amenity bookings (the part a Spring Boot service would own).
//
//   amenityPreWrite  - runs BEFORE a booking is stored: re-prices it from the catalog (the client's amounts are ignored), checks
//                      availability and the booking window, decides the payment state, and turns "actions" (cancel, receive payment,
//                      pay refund, settle deposit) into the right fields. Returns { record } or { error }.
//   amenityPostWrite - runs AFTER it is stored: posts the money (Payments Cross-check credits/debits, unit credit ledger) and queues
//                      the notifications (e-mail / SMS / WhatsApp outbox rows + the in-app bell).
//   runAmenityScheduler - the cron job: unpaid bookings are released, finished bookings completed, reminders, daily + summary reports.
//
// Residents cannot write the ledger, the credit ledger or the outbox, so these are system postings (like utilityLedger.js).
import { looksLikeHtml, htmlToText } from './richtext/sanitize.js';
import { storage } from './storage/index.js';
import { communityTaxId, localDay, todayLocal } from './locale.js';
import { COLLECTIONS } from './storage/StorageAdapter.js';
import { logChange } from './audit/auditLog.js';
import { uuid } from './uuid.js';
import { defaulterBlock } from './finance/rules.js';
import { pushNotification } from './notifications.js';
import {
  quote, priceExtras, tiersOf, startAtOf, bookingWindowError, bookingRulesError, canOverrideRules, cancellationQuote, ONLINE_MODES, OFFICE_MODES, round2, inr,
  renderTemplate, bookingVars, buildReport, addDays, BOOKING_EVENTS, defaultTemplates, creditBalance,
  isItemsOnly,
} from './amenityEngine.js';
import { defaultOnlineMode, needsRef, ALL_MODES } from './region/paymentModes.js';
const PAYOUT_ANY = () => [...ALL_MODES, 'Card'];

// Money goes back through the payment gateway only for the online modes; cash and cheque are paid out by hand.
const gatewayRef = () => `GW${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
const SYSTEM = 'System · amenity bookings';
const today = () => todayLocal();
const changed = (collection) => window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection } }));

/** Raw (unscoped) row helpers: this module plays the backend, so it reads and writes below the permission layer. */
async function nextId(collection, prefix) {
  const rows = await storage.list(collection);
  const max = rows.reduce((m, r) => { const n = Number(String(r.shortId || '').replace(`${prefix}-`, '')); return Number.isFinite(n) && n > m ? n : m; }, 0);
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
async function systemPut(collection, prefix, row, summary) {
  const now = new Date().toISOString();
  const full = { ...row, id: row.id || uuid(), shortId: row.shortId || await nextId(collection, prefix), recVersion: 1, recordCreatedAt: now, recordCreatedBy: SYSTEM, lastUpdatedAt: now, lastUpdatedBy: SYSTEM };
  await storage.put(collection, full);
  if (collection === COLLECTIONS.LEDGER) {
    await logChange({ who: SYSTEM, whoName: SYSTEM, what: 'Payments Cross-check', collection, recordId: full.id, recordShortId: full.shortId, unit: '', action: 'Create', summary: summary || full.description, changes: [] });
  }
  changed(collection);
  return full;
}


async function loadCtx() {
  const [catalog, settingsRows, bookings, credits, properties, items] = await Promise.all([
    storage.list(COLLECTIONS.AMENITY_TYPES), storage.list(COLLECTIONS.AMENITY_SETTINGS), storage.list(COLLECTIONS.AMENITIES), storage.list(COLLECTIONS.UNIT_CREDITS), storage.list(COLLECTIONS.PROPERTIES), storage.list(COLLECTIONS.AMENITY_ITEMS),
  ]);
  return { items, catalog, settings: settingsRows[0] || {}, bookings, credits, properties };
}

const isStaffActor = (p) => !!p && (p.roleId === 'super_admin' || p.role?.category === 'EC' || p.role?.permissions?.includes('MANAGE_AMENITIES'));

/* ------------------------------------------------------------ before ---- */

let paymentVerifier = null;
/** SERVER ONLY: checks that an "online" booking points at a real, unused, big-enough payment (the browser demo trusts the simulator). */
export const setPaymentVerifier = (fn) => { paymentVerifier = fn; };

export async function amenityPreWrite({ record, old, isNew, p }) {
  const ctx = await loadCtx();
  const staff = isStaffActor(p);
  const nowIso = new Date().toISOString();
  const clean = { ...record };
  const action = clean._action;
  const extra = { newFee: clean.newFee, adjustReason: String(clean.adjustReason || '').trim(), freeOfCharge: !!clean.freeOfCharge, waiveReason: String(clean.waiveReason || '').trim(), waive: !!clean.waive, refundOverride: clean.refundOverride, depositDeduction: Number(clean.depositDeduction) || 0, deductionReason: clean.deductionReason || '', paymentRef: clean.paymentRef || '', useCredit: !!clean.useCredit, refundTo: clean.refundTo || '', payoutMode: clean.payoutMode || '', initiate: !!clean.initiate };
  ['_action', 'newFee', 'adjustReason', 'freeOfCharge', 'waiveReason', 'waive', 'refundOverride', 'depositDeduction', 'deductionReason', 'paymentRef', 'useCredit', 'refundTo', 'payoutMode', 'initiate'].forEach((k) => delete clean[k]);

  /* ---- new booking ---- */
  if (isNew) {
    const amenity = ctx.catalog.find((a) => a.name === clean.amenity);
    if (!amenity) return { error: 'Unknown amenity' };
    if (amenity.active === false) return { error: 'This amenity is not open for booking right now' };
    const dayBased = amenity.bookingMode === 'Full day';
    const slot = dayBased ? 'Full day' : clean.slot;
    if (!clean.date || !slot) return { error: 'Choose a date and time slot' };
    const cap = Number(amenity.capacity) || 1;
    const taken = ctx.bookings.filter((b) => b.status !== 'Cancelled' && b.amenity === amenity.name && b.date === clean.date && (dayBased ? true : b.slot === slot)).length;
    if (!isItemsOnly(amenity) && taken >= cap) return { error: 'That booking is no longer available.' };
    if (amenity.reservation === 'Walk-in (no reservation)' && !staff) return { error: `${amenity.name} needs no reservation. Just walk in.` };
    const bypass = canOverrideRules(amenity, p?.roleId, staff);
    if (!bypass) {
      const w = bookingWindowError(amenity, clean.date, slot);
      if (w) return { error: w };
      const prop = ctx.properties?.find((x) => x.unit === clean.unit);
      const lim = bookingRulesError(amenity, { date: clean.date, unit: clean.unit, unitType: prop?.type || '', bookings: ctx.bookings });
      if (lim) return { error: lim };
    }
    if (!staff) {
      const hold = await defaulterBlock(clean.unit);
      if (hold) return { error: hold };
    } else if (startAtOf(clean.date, slot, amenity) < `${today()}T00:00:00`) return { error: 'That date has already passed.' };

    const picks = (() => { try { return JSON.parse(clean.extras || '{}'); } catch { return {}; } })();
    const ex = priceExtras(picks, ctx.items, ctx.bookings, amenity.name, clean.date, slot);
    if (ex.error) return { error: ex.error };
    if (isItemsOnly(amenity) && !ex.lines.length) return { error: `Choose how many of each item you need from ${amenity.name}` };
    clean.extras = ex.lines.length ? JSON.stringify(ex.lines) : ''; clean.extrasTotal = ex.total;
    let q = quote(amenity, clean.date, ctx.settings, ex.total);
    // staff may reserve for an association (or any unit) free of charge: nothing is charged, no deposit is taken, and the value waived is recorded
    const association = clean.bookedFor === 'Association';
    if (!staff && (association || extra.freeOfCharge)) return { error: 'Only the amenities team can reserve for an association or waive the charges' };
    if (association && !String(clean.association || '').trim()) return { error: 'Name the association' };
    if (association) clean.unit = `Association · ${String(clean.association).trim()}`;
    const waived = staff && extra.freeOfCharge && q.total > 0;
    if (waived && !extra.waiveReason) return { error: 'Give a reason for waiving the charges' };
    const waivedAmount = waived ? q.total : 0;
    if (waived) q = { ...q, rate: 0, base: 0, gst: 0, gstRate: 0, fee: 0, deposit: 0, total: 0, halves: 0, free: true };
    let mode = clean.paymentMode || defaultOnlineMode();
    let paymentStatus;
    let status;
    let creditApplied = 0;
    // unit credit can cover all of a booking or part of it (the rest is paid in the chosen mode)
    if (q.total > 0 && extra.useCredit) creditApplied = Math.min(round2(creditBalance(ctx.credits, clean.unit)), q.total);
    if (creditApplied < 0.01) creditApplied = 0;
    const remaining = round2(q.total - creditApplied);
    if (q.total <= 0) { paymentStatus = 'Not required'; status = 'Confirmed'; mode = ''; }
    else if (creditApplied > 0 && remaining <= 0) { paymentStatus = 'Paid'; status = 'Confirmed'; mode = 'Unit credit'; }
    else if (ONLINE_MODES.includes(mode)) {
      if (paymentVerifier) { const why = await paymentVerifier({ ref: extra.paymentRef, unit: clean.unit, amount: remaining, bookingId: record.id || '' }); if (why) return { error: why }; }
      paymentStatus = 'Paid'; status = 'Confirmed';
    }
    else if (OFFICE_MODES.includes(mode)) { paymentStatus = staff ? 'Paid' : 'Pending'; status = paymentStatus === 'Paid' ? 'Confirmed' : 'Pending payment'; }
    else return { error: 'Choose a payment option' };
    const paid = paymentStatus === 'Paid';
    const out = {
      ...clean,
      slot, status, paymentMode: mode, paymentStatus,
      rate: q.rate, rateUnit: q.rateUnit, qty: 1, baseAmount: q.base, gstRate: q.gstRate, gstAmount: q.gst, gstMode: q.gstMode, feeTotal: q.fee,
      depositAmount: q.deposit, totalPayable: q.total, paidAmount: paid ? q.total : 0, paidAt: paid ? today() : '', creditApplied, paymentRef: extra.paymentRef || '',
      depositStatus: q.deposit > 0 ? (paid ? 'Held' : 'Awaiting payment') : 'None', refundStatus: 'None', refundAmount: 0,
      startAt: startAtOf(clean.date, slot, amenity), policySnapshot: tiersOf(amenity), bookedBy: p?.name || '',
      ...(association ? { bookedFor: 'Association', association: String(clean.association).trim() } : { bookedFor: 'Unit' }),
      ...(waivedAmount > 0 ? { chargeWaived: true, waivedAmount, waiveReason: extra.waiveReason } : {}),
    };
    return { record: out, action: 'create', amenity };
  }

  /* ---- existing booking: only through an action ---- */
  const amenity = ctx.catalog.find((a) => a.name === old.amenity) || {};
  if (!action) {
    // free-text notes are harmless; money and state fields only move through actions
    const moved = Object.keys(clean).filter((k) => !['id', 'shortId', 'recVersion', 'recordCreatedAt', 'recordCreatedBy', 'lastUpdatedAt', 'lastUpdatedBy', 'notes'].includes(k) && JSON.stringify(clean[k]) !== JSON.stringify(old[k]));
    if (moved.length) return { error: `Use the booking actions (cancel, receive payment, refund, deposit) - ${moved.join(', ')} cannot be edited directly` };
    return { record: clean, action: '' };
  }
  const staffOnly = ['adjust_fee', 'receive_payment', 'mark_refund_paid', 'refund_to_credit', 'settle_deposit', 'mark_deposit_paid', 'complete'];
  if (staffOnly.includes(action) && !staff) return { error: 'Requires amenities management access' };

  if (action === 'adjust_fee') {
    // a wrong price on a booking nobody has paid for yet; a paid one is cancelled with the right refund and booked again
    if (!['Confirmed', 'Pending payment'].includes(old.status)) return { error: 'Only a live booking can be corrected' };
    if (old.paymentStatus === 'Paid' || Number(old.creditApplied) > 0) return { error: 'This booking is already paid (or part-paid from credit). Cancel it with the right refund, then book it again at the correct price.' };
    const fee = round2(extra.newFee);
    if (!(fee >= 0) || extra.newFee === '' || extra.newFee == null) return { error: 'Enter the correct fee' };
    if (!extra.adjustReason) return { error: 'Give a reason for the correction' };
    const rate = Number(old.gstRate) || 0; const gst = rate > 0 ? round2(fee - fee / (1 + rate / 100)) : 0;
    const total = round2(fee + (Number(old.depositAmount) || 0));
    return { record: { ...old, ...clean, baseAmount: round2(fee - gst), gstAmount: gst, feeTotal: fee, totalPayable: total, rate: Math.min(Number(old.rate) || fee, fee) || fee, paymentStatus: total <= 0 ? 'Not required' : old.paymentStatus, status: total <= 0 ? 'Confirmed' : old.status, feeCorrectedFrom: Number(old.feeTotal) || 0, feeCorrectionReason: extra.adjustReason, feeCorrectedBy: p?.name || '', feeCorrectedAt: nowIso }, action, amenity };
  }
  if (action === 'cancel') {
    if (['Cancelled', 'Completed'].includes(old.status)) return { error: 'This booking is already finished' };
    const startAt = old.startAt || startAtOf(old.date, old.slot, amenity);
    if (!staff && new Date(startAt) < new Date()) return { error: 'This booking has already started' };
    const waive = staff && extra.waive;
    const cq = cancellationQuote(old, amenity, new Date(), { waive });
    let refundFee = cq.refundFee;
    if (staff && Number.isFinite(Number(extra.refundOverride)) && extra.refundOverride !== '' && extra.refundOverride != null) refundFee = Math.min(cq.feePaid, Math.max(0, round2(extra.refundOverride)));
    const refund = round2(refundFee + cq.refundDeposit);
    const credit = ctx.settings.refundMode !== 'Original payment mode (manual)';
    const wasPaid = old.paymentStatus === 'Paid';
    const viaCredit = old.paymentMode === 'Unit credit' || Number(old.creditApplied) > 0;
    // the guest picks where a refund goes; the community setting is only the default. Paid (even partly) from unit credit -> back to the account.
    const wantCredit = extra.refundTo ? extra.refundTo === 'credit' : credit;
    const toAccount = wantCredit || viaCredit;
    if (!wasPaid && Number(old.creditApplied) > 0) {
      // nothing was paid in cash yet, only unit credit was reserved: give it straight back
      return { record: { ...old, ...clean, status: 'Cancelled', cancelledAt: nowIso, cancelledBy: p?.name || '', cancelReason: clean.cancelReason || '', refundPct: 100, refundFeeAmount: 0, depositReturned: 0, retainedAmount: 0, refundAmount: Number(old.creditApplied), refundTo: 'Unit account', refundStatus: 'Credited to unit account', creditRestored: true, refundDecidedAt: nowIso, paymentStatus: 'Cancelled', depositStatus: old.depositStatus === 'Awaiting payment' ? 'None' : old.depositStatus }, action, amenity, cq };
    }
    const out = {
      ...old, ...clean, status: 'Cancelled', cancelledAt: nowIso, cancelledBy: p?.name || '', cancelReason: clean.cancelReason || (waive ? 'Cancelled by the community' : ''),
      refundPct: waive ? 100 : cq.pct, refundFeeAmount: refundFee, depositReturned: cq.refundDeposit, retainedAmount: round2(cq.feePaid - refundFee), refundAmount: refund,
      // paid by unit credit -> the refund always goes back to the unit account
      refundTo: refund > 0 ? (toAccount ? 'Unit account' : `Original payment mode${old.paymentMode ? ` (${old.paymentMode})` : ''}`) : '', refundDecidedAt: nowIso,
      refundStatus: refund > 0 ? (toAccount ? 'Credited to unit account' : 'Refund due') : 'None',
      paymentStatus: !wasPaid ? 'Cancelled' : refund <= 0 ? 'Paid' : (toAccount ? (refund >= round2(old.totalPayable) ? 'Refunded' : 'Partially refunded') : 'Refund due'),
      depositStatus: old.depositStatus === 'Held' ? 'Returned' : old.depositStatus === 'Awaiting payment' ? 'None' : old.depositStatus,
    };
    return { record: out, action, amenity, cq };
  }
  if (action === 'receive_payment') {
    if (old.paymentStatus !== 'Pending') return { error: 'No payment is pending on this booking' };
    const out = { ...old, ...clean, status: 'Confirmed', paymentStatus: 'Paid', paidAmount: old.totalPayable, paidAt: today(), paymentMode: clean.paymentMode || old.paymentMode, paymentRef: extra.paymentRef, depositStatus: Number(old.depositAmount) > 0 ? 'Held' : 'None' };
    return { record: out, action, amenity };
  }
  if (action === 'mark_refund_paid') {
    if (old.refundStatus !== 'Refund due') return { error: 'No refund is due on this booking' };
    const partial = round2(old.refundAmount) < round2(old.totalPayable);
    const pm = extra.initiate ? old.paymentMode : (extra.payoutMode || old.paymentMode || 'Cash');
    if (extra.initiate) {
      if (!ONLINE_MODES.includes(pm)) return { error: `A ${pm || 'cash'} payment cannot be sent back automatically - pay it out and record it instead` };
      extra.paymentRef = gatewayRef();
    }
    if (!PAYOUT_ANY().includes(pm)) return { error: 'Choose how the refund was paid' };
    if (needsRef(pm) && !String(extra.paymentRef || '').trim()) return { error: `Enter the ${pm === 'Cheque' ? 'cheque number' : 'transaction / UTR reference'}` };
    return { record: { ...old, ...clean, refundStatus: 'Refunded', paymentStatus: partial ? 'Partially refunded' : 'Refunded', refundPaidAt: today(), refundPaidBy: p?.name || '', refundPayoutMode: pm, refundRef: extra.paymentRef, ...(extra.initiate ? { refundInitiatedAt: new Date().toISOString(), refundInitiatedBy: p?.name || '', refundVia: 'Payment gateway (original mode)' } : {}) }, action, amenity };
  }
  if (action === 'refund_to_credit') {
    if (old.refundStatus !== 'Refund due') return { error: 'No refund is due on this booking' };
    const partial = round2(old.refundAmount) < round2(old.totalPayable);
    return { record: { ...old, ...clean, refundStatus: 'Credited to unit account', refundTo: 'Unit account', paymentStatus: partial ? 'Partially refunded' : 'Refunded', refundPaidAt: today(), refundPaidBy: p?.name || '', refundPayoutMode: 'Unit credit' }, action, amenity };
  }
  if (action === 'complete') {
    if (old.status !== 'Confirmed') return { error: 'Only a confirmed booking can be completed' };
    return { record: { ...old, ...clean, status: 'Completed' }, action, amenity };
  }
  if (action === 'settle_deposit') {
    if (old.depositStatus !== 'Held') return { error: 'No security deposit is held for this booking' };
    if (old.status === 'Cancelled') return { error: 'A cancelled booking already returned its deposit' };
    const dep = round2(old.depositAmount);
    const ded = Math.min(dep, Math.max(0, round2(extra.depositDeduction)));
    const plain = String(extra.deductionReason || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (ded > 0 && !plain) return { error: 'Give a reason for the deduction' };
    const photos = Array.isArray(clean.depositPhotos) ? clean.depositPhotos : [];
    if (ded > 0 && !photos.length) return { error: 'Attach at least one photo as evidence for the deduction' };
    const back = round2(dep - ded);
    const viaCredit = old.paymentMode === 'Unit credit' || Number(old.creditApplied) > 0;
    const defMode = ctx.settings.refundMode !== 'Original payment mode (manual)' || viaCredit ? 'Unit credit' : (old.paymentMode || 'Cash');
    const pm = extra.payoutMode || defMode;
    if (!['Unit credit', ...PAYOUT_ANY()].includes(pm)) return { error: 'Choose how the deposit is returned' };
    const credit = pm === 'Unit credit';
    return {
      record: {
        ...old, ...clean, status: old.status === 'Confirmed' ? 'Completed' : old.status, depositReturned: back, depositDeduction: ded, depositDeductionReason: plain ? extra.deductionReason : '', depositPhotos: photos, depositSettledBy: p?.name || '', depositRefundMode: back > 0 ? pm : '', depositSettledAt: today(),
        depositStatus: ded === 0 ? 'Released' : ded >= dep ? 'Forfeited' : 'Partly forfeited', depositRefundStatus: back > 0 ? (credit ? 'Credited to unit account' : 'Due') : 'None',
      }, action, amenity,
    };
  }
  if (action === 'mark_deposit_paid') {
    if (old.depositRefundStatus !== 'Due') return { error: 'No deposit refund is due' };
    const pm = extra.initiate ? (old.paymentMode) : (extra.payoutMode || old.depositRefundMode || 'Cash');
    if (extra.initiate) {
      if (!ONLINE_MODES.includes(pm)) return { error: `A ${pm || 'cash'} payment cannot be sent back automatically - pay it out and record it instead` };
      extra.paymentRef = gatewayRef();
    }
    if (needsRef(pm) && !String(extra.paymentRef || '').trim()) return { error: `Enter the ${pm === 'Cheque' ? 'cheque number' : 'transaction / UTR reference'}` };
    return { record: { ...old, ...clean, depositRefundStatus: 'Paid', depositRefundPaidAt: today(), depositRefundPaidBy: p?.name || '', depositRefundMode: pm, depositRefundRef: extra.paymentRef || '', ...(extra.initiate ? { depositRefundInitiatedAt: new Date().toISOString(), depositRefundVia: 'Payment gateway (original mode)' } : {}) }, action, amenity };
  }
  return { error: `Unknown action ${action}` };
}

/* ------------------------------------------------------------- after ---- */

async function ledgerRow({ date = today(), description, type, amount, base, gstRate, gst, sourceId, account, unit = '', bookingNo = '', nonCash = false }) {
  return systemPut(COLLECTIONS.LEDGER, 'LED', {
    date, account, description, category: 'Amenities', module: 'Amenities', sourceType: 'booking', reconStatus: 'Unreconciled', type, amount: round2(amount), vendor: '', sourceId, unit, bookingNo, ...(nonCash ? { nonCash: true } : {}),
    ...(gst != null ? { baseAmount: round2(base), gstRate, gstAmount: round2(gst) } : {}), attachments: [],
  });
}

async function receiptAccount(settings) {
  if (settings.receiptAccount) return settings.receiptAccount;
  const banks = await storage.list(COLLECTIONS.BANK_ACCOUNTS);
  return banks[0]?.name || 'Maintenance';
}

export async function amenityPostWrite({ old, next, action }) {
  const ctx = await loadCtx();
  const { settings } = ctx;
  const account = await receiptAccount(settings);
  const tag = `${next.shortId} · ${next.amenity} · ${next.date} · ${next.unit}`;
  const ledgerHas = async (sourceId) => (await storage.list(COLLECTIONS.LEDGER)).some((l) => l.sourceId === sourceId);
  const credit = (amount, reason) => systemPut(COLLECTIONS.UNIT_CREDITS, 'UCR', { unit: next.unit, type: 'Credit', amount: round2(amount), reason, bookingId: next.id, bookingNo: next.shortId, date: today() });
  const debit = (amount, reason) => systemPut(COLLECTIONS.UNIT_CREDITS, 'UCR', { unit: next.unit, type: 'Debit', amount: round2(amount), reason, bookingId: next.id, bookingNo: next.shortId, date: today() });

  // money in: the fee (income, with its GST) and the refundable deposit (held, not income) are separate lines
  const L = { account, unit: next.unit, bookingNo: next.shortId };
  const postReceipt = async () => {
    const creditUsed = round2(next.creditApplied);
    if (Number(next.feeTotal) > 0 && !(await ledgerHas(`amenity:${next.id}:fee`))) {
      await ledgerRow({ ...L, description: `Amenity booking ${tag} — fee (taxable ${inr(next.baseAmount)} + GST ${inr(next.gstAmount)})`, type: 'Credit', amount: next.feeTotal, base: next.baseAmount, gstRate: next.gstRate, gst: next.gstAmount, sourceId: `amenity:${next.id}:fee` });
    }
    if (Number(next.depositAmount) > 0 && !(await ledgerHas(`amenity:${next.id}:deposit`))) {
      await ledgerRow({ ...L, description: `Amenity booking ${tag} — refundable security deposit`, type: 'Credit', amount: next.depositAmount, sourceId: `amenity:${next.id}:deposit` });
    }
    // paid from the unit's credit balance: no cash arrives, so the receipt is offset by a non-cash debit and the books still show the booking
    if (creditUsed > 0 && !(await ledgerHas(`amenity:${next.id}:creditused`))) {
      await ledgerRow({ ...L, description: `${creditUsed >= round2(next.totalPayable) ? 'Paid' : 'Part-paid'} from unit credit (non-cash) ${tag}`, type: 'Debit', amount: creditUsed, sourceId: `amenity:${next.id}:creditused`, nonCash: true });
    }
  };
  // money returned to the unit's credit balance: cash stays in the fund, so a matching non-cash credit is posted beside the refund debit
  const creditedToUnit = async (key, amount, what) => {
    if (!(Number(amount) > 0) || await ledgerHas(`amenity:${next.id}:${key}`)) return;
    await ledgerRow({ ...L, description: `${what} — credited to unit account (non-cash) ${tag}`, type: 'Debit', amount, sourceId: `amenity:${next.id}:${key}`, nonCash: true });
    await ledgerRow({ ...L, description: `Held as unit credit (liability) ${tag}`, type: 'Credit', amount, sourceId: `amenity:${next.id}:${key}:held`, nonCash: true });
  };

  if (action === 'create') {
    // unit credit is taken (reserved) the moment the booking is made, even if the rest is still to be paid at the office
    if (Number(next.creditApplied) > 0) await debit(next.creditApplied, `Used on booking ${next.shortId} (${next.amenity})`);
    if (next.paymentStatus === 'Paid') await postReceipt();
    await amenityNotify(next.paymentStatus === 'Pending' ? 'booking_pending' : 'booking_confirmed', next, ctx);
  } else if (action === 'receive_payment') {
    await postReceipt();
    await amenityNotify('payment_received', next, ctx);
  } else if (action === 'cancel') {
    if (next.refundStatus === 'Credited to unit account' && next.refundAmount > 0) { await credit(next.refundAmount, `Refund for cancelled booking ${next.shortId} (${next.amenity})`); if (!next.creditRestored) await creditedToUnit('refundcredit', next.refundAmount, 'Refund of cancelled booking'); }
    else if (next.refundStatus === 'Refund due' && next.paymentStatus !== 'Cancelled') await ledgerRow({ ...L, description: `Cancelled booking ${tag} — refund of ${inr(next.refundAmount)} awaiting payment (retained ${inr(next.retainedAmount)})`, type: 'Debit', amount: 0, sourceId: `amenity:${next.id}:cancelled`, nonCash: true });
    await amenityNotify('booking_cancelled', next, ctx);
    if (next.refundStatus === 'Credited to unit account' && next.refundAmount > 0) await amenityNotify('refund_processed', next, ctx);
  } else if (action === 'refund_to_credit') {
    await credit(next.refundAmount, `Refund for cancelled booking ${next.shortId} (${next.amenity})`); await creditedToUnit('refundcredit', next.refundAmount, 'Refund of cancelled booking');
    await amenityNotify('refund_processed', next, ctx);
  } else if (action === 'mark_refund_paid') {
    await ledgerRow({ ...L, description: `Refund ${tag} — cancelled booking · ${next.refundPayoutMode || ''}${next.refundRef ? ` ${next.refundRef}` : ''}`, type: 'Debit', amount: next.refundAmount, sourceId: `amenity:${next.id}:refund` });
    await amenityNotify('refund_processed', next, ctx);
  } else if (action === 'settle_deposit') {
    if (next.depositRefundStatus === 'Credited to unit account' && next.depositReturned > 0) { await credit(next.depositReturned, `Security deposit returned for ${next.shortId} (${next.amenity})`); await creditedToUnit('depositcredit', next.depositReturned, 'Security deposit returned'); }
    await amenityNotify('deposit_settled', next, ctx, { reason: next.depositDeductionReason ? `Deducted ${inr(next.depositDeduction)}: ${String(next.depositDeductionReason).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}` : '' });
  } else if (action === 'mark_deposit_paid') {
    await ledgerRow({ ...L, description: `Security deposit returned ${tag} · ${next.depositRefundMode || ''}${next.depositRefundRef ? ` ${next.depositRefundRef}` : ''}`, type: 'Debit', amount: next.depositReturned, sourceId: `amenity:${next.id}:depositpaid` });
    await amenityNotify('refund_processed', next, ctx, { extra: { refund: inr(next.depositReturned) } });
  }
  changed(COLLECTIONS.AMENITIES);
}

/* -------------------------------------------------------- notifications -- */

async function communityName() {
  const mf = (await storage.list(COLLECTIONS.MERGE_FIELDS)).find((m) => m.token === '{{SOCIETY_NAME}}');
  return mf?.defaultValue || 'Community';
}
const ownerOf = async (unit) => {
  const users = await storage.list(COLLECTIONS.USERS);
  const u = users.find((x) => x.status !== 'Inactive' && (x.units || []).includes(unit));
  if (u) return { name: u.name, email: u.email || '', phone: u.phone || '' };
  const prop = (await storage.list(COLLECTIONS.PROPERTIES)).find((x) => x.unit === unit);
  return { name: prop?.owner || '', email: '', phone: prop?.ownerPhone || '' };
};

/** Queue one outbox row. A real gateway (SMTP / SMS / WhatsApp Business API) replaces `status` with the delivery receipt. */
async function queue(row0) {
  // rich-text (HTML) e-mail bodies: the outbox keeps the readable text and the formatted version separately
  const isHtml = looksLikeHtml(row0.body);
  const row = isHtml ? { ...row0, body: htmlToText(row0.body), ...(row0.channel === 'Email' ? { html: row0.body } : {}) } : row0;
  return systemPut(COLLECTIONS.NOTIFICATION_OUTBOX, 'OUT', { ...row, status: row.to ? 'Queued — demo, not delivered' : 'Skipped — no contact', createdAt: new Date().toISOString() });
}

export async function amenityNotify(event, booking, ctx, { reason = '', extra = {} } = {}) {
  const { settings } = ctx || await loadCtx();
  const templates = (await storage.list(COLLECTIONS.NOTIFICATION_TEMPLATES)).filter((t) => t.event === event && t.enabled !== false);
  const name = await communityName();
  const owner = await ownerOf(booking.unit);
  const vars = bookingVars(booking, { community: name, settings, owner: owner.name, reason, extra });
  const admins = Array.isArray(settings.adminRecipients) ? settings.adminRecipients : [];
  for (const t of templates) {
    const subject = renderTemplate(t.subject, vars);
    const body = renderTemplate(t.body, vars);
    if (t.audience === 'Owner' && settings.notifyOwner !== false) {
      await queue({ event, channel: t.channel, audience: 'Owner', to: t.channel === 'Email' ? owner.email : owner.phone, toLabel: owner.name || booking.unit, subject, body, bookingId: booking.id, bookingNo: booking.shortId, unit: booking.unit });
    }
    if (t.audience === 'Admin' && settings.notifyAdmin !== false) {
      for (const r of admins.filter((a) => a.channel === t.channel && a.target)) {
        await queue({ event, channel: t.channel, audience: 'Admin', to: r.target, toLabel: r.label || r.target, subject, body, bookingId: booking.id, bookingNo: booking.shortId, unit: booking.unit });
      }
    }
  }
  // the in-app bell: the villa (owner-facing events) and amenity managers
  const title = { booking_confirmed: 'Booking confirmed', booking_pending: 'Booking awaiting payment', payment_received: 'Payment received', booking_cancelled: 'Booking cancelled', refund_processed: 'Refund processed', deposit_settled: 'Deposit settled', payment_expired: 'Booking released', reminder: 'Booking reminder' }[event];
  if (title) {
    const base = { kind: 'amenity', ticketNumber: '', link: `#/amenities/${booking.shortId}`, read: false, createdAt: new Date().toISOString(), title: `${title} · ${booking.shortId}`, body: `${booking.amenity} · ${booking.date} · ${booking.slot}` };
    if (BOOKING_EVENTS.includes(event)) await pushNotification({ ...base, id: uuid(), toUnit: booking.unit });
    await pushNotification({ ...base, id: uuid(), toRoleIds: settings.inAppRoleIds || ['facility_manager', 'committee_amenities'] });
  }
}

/** Send (queue) a daily or summary report to every report recipient, in the channels that have an enabled template. */
export async function sendReport(kind, { from, to } = {}) {
  const { settings, bookings } = await loadCtx();
  const name = await communityName();
  const t0 = today();
  const range = kind === 'daily' ? { from: t0, to: t0 } : { from: from || addDays(t0, -(settings.summaryReport === 'Monthly' ? 30 : 7)), to: to || t0 };
  const report = buildReport(kind, { bookings, community: name, settings, today: t0, ...range });
  const event = kind === 'daily' ? 'daily_report' : 'summary_report';
  const templates = (await storage.list(COLLECTIONS.NOTIFICATION_TEMPLATES)).filter((t) => t.event === event && t.enabled !== false);
  const recips = Array.isArray(settings.reportRecipients) ? settings.reportRecipients : [];
  let n = 0;
  for (const t of templates) {
    const vars = { community: name, report: report.text, report_period: kind === 'daily' ? t0 : `${range.from} to ${range.to}`, gstin: communityTaxId() };
    for (const r of recips.filter((x) => x.channel === t.channel && x.target)) {
      await queue({ event, channel: t.channel, audience: 'Admin', to: r.target, toLabel: r.label || r.target, subject: renderTemplate(t.subject, vars), body: renderTemplate(t.body, vars), reportKind: kind });
      n++;
    }
  }
  return { ...report, queued: n, range };
}

/* ------------------------------------------------------------ scheduler -- */

/** Communities created before this feature (or from the empty template) get the default settings row and message templates. */
export async function ensureAmenityDefaults() {
  const [settings, templates] = await Promise.all([storage.list(COLLECTIONS.AMENITY_SETTINGS), storage.list(COLLECTIONS.NOTIFICATION_TEMPLATES)]);
  if (!settings.length) {
    await systemPut(COLLECTIONS.AMENITY_SETTINGS, 'AMS', { gstin: '', defaultGstRate: 18, receiptAccount: '', refundMode: 'Credit to unit account', paymentDueHours: 48, notifyOwner: true, notifyAdmin: true, reminderOn: false, dailyReport: false, dailyReportTime: '20:00', summaryReport: 'Off', adminRecipients: [], reportRecipients: [], inAppRoleIds: ['facility_manager', 'committee_amenities'] });
  }
  if (!templates.length) for (const t of defaultTemplates()) await systemPut(COLLECTIONS.NOTIFICATION_TEMPLATES, 'NTM', { ...t, id: uuid() });
}

/** Idempotent "cron": safe to call on every app open and every minute. Uses system writes only. */
export async function runAmenityScheduler(now = new Date()) {
  await ensureAmenityDefaults();
  const ctx = await loadCtx();
  const { settings, bookings, catalog } = ctx;
  const t0 = localDay(now);
  const stats = { released: 0, completed: 0, reminders: 0, daily: false, summary: false };
  const stamp = async (row, patch) => { const next = { ...row, ...patch, recVersion: (row.recVersion || 0) + 1, lastUpdatedAt: now.toISOString(), lastUpdatedBy: SYSTEM }; await storage.put(COLLECTIONS.AMENITIES, next); return next; };

  // 1. unpaid cash / cheque bookings are released after the grace period
  const dueH = Number(settings.paymentDueHours) || 0;
  if (dueH > 0) {
    for (const b of bookings.filter((x) => x.status === 'Pending payment' && x.paymentStatus === 'Pending')) {
      if (now - new Date(b.recordCreatedAt) > dueH * 3600000) {
        const next = await stamp(b, { status: 'Cancelled', paymentStatus: 'Cancelled', depositStatus: 'None', cancelledAt: now.toISOString(), cancelledBy: SYSTEM, cancelReason: `Payment not received within ${dueH} hours`, refundStatus: 'None', refundAmount: 0 });
        if (Number(b.creditApplied) > 0) await systemPut(COLLECTIONS.UNIT_CREDITS, 'UCR', { unit: b.unit, type: 'Credit', amount: round2(b.creditApplied), reason: `Booking ${b.shortId} released unpaid - credit given back`, bookingId: b.id, bookingNo: b.shortId, date: t0 });
        await amenityNotify('payment_expired', next, ctx);
        stats.released++;
      }
    }
  }
  // 2. confirmed bookings whose day has passed become Completed (so the deposit can be settled)
  for (const b of bookings.filter((x) => x.status === 'Confirmed' && x.date < t0)) { await stamp(b, { status: 'Completed' }); stats.completed++; }
  // 3. the day-before reminder to the owner
  if (settings.reminderOn) {
    const tmr = addDays(t0, 1);
    for (const b of bookings.filter((x) => x.status === 'Confirmed' && x.date === tmr && !x.reminderSent)) {
      const next = await stamp(b, { reminderSent: true });
      await amenityNotify('reminder', next, ctx);
      stats.reminders++;
    }
  }
  // 4. reports
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const runs = (await storage.list(COLLECTIONS.AMENITY_SETTINGS))[0];
  if (runs) {
    let patch = null;
    if (settings.dailyReport && runs.lastDailyRun !== t0 && hhmm >= (settings.dailyReportTime || '20:00')) { await sendReport('daily'); patch = { ...(patch || {}), lastDailyRun: t0 }; stats.daily = true; }
    const freq = settings.summaryReport;
    const dow = now.getDay();
    const due = (freq === 'Weekly' && dow === 1) || (freq === 'Monthly' && now.getDate() === 1);
    if (due && runs.lastSummaryRun !== t0 && hhmm >= (settings.dailyReportTime || '20:00')) { await sendReport('summary'); patch = { ...(patch || {}), lastSummaryRun: t0 }; stats.summary = true; }
    if (patch) await storage.put(COLLECTIONS.AMENITY_SETTINGS, { ...runs, ...patch });
  }
  if (stats.released || stats.completed || stats.reminders) changed(COLLECTIONS.AMENITIES);
  return stats;
}

