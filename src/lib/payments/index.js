// PaymentService - the one entry point the UI uses. It never knows which provider is active.
//   const result = await pay({ purpose:'due', refs:[dueId], amount, unit, payer }, checkoutUi);
// Registry: gateways by id; settlers by purpose (what to do once money is confirmed). Both are extension points.
import SimulatedGateway from './SimulatedGateway.js';
import V2Gateway from './V2Gateway.js';
import { getDataSource } from '../storage/dataSource.js';
import { serverDecides } from '../auth/session.js';
import { OUTCOME, ORDER_STATUS } from './PaymentGateway.js';
import { region } from '../region/regions.js';
import { getCommunityConfig } from '../locale.js';
import { settleDues } from '../finance/settle.js';
import { notify } from '../notify.js';
import { dmy } from '../finance/rules.js';
import { COLLECTIONS } from '../storage/StorageAdapter.js';

const gateways = {}; const settlers = {};
export const registerGateway = (g) => { gateways[g.id] = g; return g; };
export const registerSettler = (purpose, fn) => { settlers[purpose] = fn; };
export const listGateways = () => Object.values(gateways);
registerGateway(new SimulatedGateway());
registerGateway(new V2Gateway());

/** The community's chosen provider if the country supports it, else the first one the country supports, else the simulator. */
export function activeGateway() {
  if (getDataSource().mode === 'v2') return gateways.v2;   // the typed v2 API: priced, verified and settled by backend/api
  const want = getCommunityConfig().paymentGateway;
  const ok = region().gateways;
  const id = (want && gateways[want] && ok.includes(want)) ? want : (ok.find((g) => gateways[g]) || 'simulated');
  return gateways[id] || gateways.simulated;
}

const EVT_KEY = 'communityos:gw:events';
/** A UPI payment's own references: the payer's UPI ID and the bank's UTR (what the office matches against the bank statement). */
const upiOf = (ev) => (ev.payerVpa || ev.utr ? { payerVpa: ev.payerVpa || '', utr: ev.utr || '', upiApp: ev.upiApp || '' } : {});
/** "UPI · asha@okhdfcbank · UTR 612345678901" (or ''), for receipts and the payment's reference. */
export const paidVia = (o) => (o?.utr || o?.payerVpa ? ['UPI', o.payerVpa, o.utr ? `UTR ${o.utr}` : ''].filter(Boolean).join(' · ') : '');
const seen = () => { try { return new Set(JSON.parse(sessionStorage.getItem(EVT_KEY) || '[]')); } catch { return new Set(); } };
const remember = (s) => { try { sessionStorage.setItem(EVT_KEY, JSON.stringify([...s].slice(-500))); } catch { /* ignore */ } };

/** SERVER side in production. Verifies the signature, ignores repeats, then settles the records. Returns what happened. */
export async function receiveWebhook(gw, raw, signature) {
  if (!(await gw.verifyWebhook(raw, signature))) return { ok: false, reason: 'Bad signature - event ignored' };
  const ev = JSON.parse(raw);
  const done = seen();
  if (done.has(ev.id)) return { ok: true, duplicate: true };
  const order = await gw.getOrder(ev.orderId);
  if (!order) return { ok: false, reason: 'Unknown order' };
  if (ev.type === 'payment.captured') {
    if (order.status === ORDER_STATUS.PAID) { done.add(ev.id); remember(done); return { ok: true, duplicate: true }; } // second capture of the same order
    const settle = settlers[order.purpose];
    if (settle) await settle(order, ev);
    await gw.markOrder?.(order.orderId, { status: ORDER_STATUS.PAID, paymentId: ev.paymentId, method: ev.method, paidAt: ev.at, ...upiOf(ev) });
  } else if (ev.type === 'payment.failed') await gw.markOrder?.(order.orderId, { status: ORDER_STATUS.FAILED, method: ev.method, ...upiOf(ev), utr: '' });
  else await gw.markOrder?.(order.orderId, { status: ORDER_STATUS.PENDING, method: ev.method, ...upiOf(ev) });   // the UTR is kept: the same payment is confirmed later
  done.add(ev.id); remember(done);
  return { ok: true };
}

/**
 * Start a payment. `ui(order, gateway)` shows the provider's checkout and resolves { outcome, method } (or { outcome: null } if the payer closed it).
 * Resolves { status: 'Paid'|'Failed'|'Pending'|'Cancelled', order, paymentId, message }.
 */
// What a payment changes, by its purpose: the screens showing these lists reload when it is paid (or is being confirmed).
const CHANGES = { due: [COLLECTIONS.DUES, COLLECTIONS.LEDGER], booking: [COLLECTIONS.AMENITIES, COLLECTIONS.LEDGER], donation: [COLLECTIONS.CULTURAL_DONATIONS, COLLECTIONS.LEDGER] };
/**
 * `stage(s)` (optional) hears what the payment is waiting on, so the screen can say so while a bank is slow:
 *   'order'    asking the server for the order (priced from what is owed now)
 *   null       the payer is on the checkout page (nothing to show over it)
 *   'confirm'  the checkout answered: confirming the payment with the bank / provider
 *   'bank'     waiting for the bank's confirmation to reach the server (seconds, sometimes longer)
 */
export async function pay(req, ui, stage = () => {}) {
  try {
    const r = await payOnce(req, ui, stage);
    if (r.status === 'Paid' || r.status === 'Pending') announce(req.purpose);
    return r;
  } finally { stage(null); }
}
async function payOnce(req, ui, stage) {
  const gw = activeGateway();
  let order;
  stage('order');
  try { order = await gw.createOrder({ currency: region().currency.code, idempotencyKey: `${req.purpose}:${[...(req.refs || [])].sort().join(',')}:${req.amount}`, ...req }); }
  catch (e) { return { status: 'Failed', order: null, message: `${e.message} You were not charged.` }; }   // could not even start: nothing has been charged
  if (gw.live && order.status === 'Paid') return { status: 'Paid', order, paymentId: order.paymentId, message: 'Payment received.' };   // already paid earlier (a retry after a closed page)
  let res;
  stage(null);
  try { res = await gw.checkout(order, ui); }
  catch (e) { return { status: 'Pending', order, checking: true, message: 'We could not confirm the payment with the bank yet.' }; }   // may have been charged: never say "failed" here
  if (!res || !res.outcome) return { status: 'Cancelled', order, message: 'Payment cancelled - nothing was charged.' };
  stage('bank');
  if (gw.live) return waitForServer(gw, order);
  if (gw.buildWebhook) { // simulator: play the provider's server call. Real providers deliver the webhook to Spring Boot on their own.
    const ev = await gw.buildWebhook(order, res.outcome, res.method, res.upi);
    const r = await receiveWebhook(gw, ev.raw, ev.signature);
    if (!r.ok) return { status: 'Failed', order, message: r.reason };
  }
  const final = await gw.getOrder(order.orderId);
  const status = final?.status === ORDER_STATUS.PAID ? 'Paid' : final?.status === ORDER_STATUS.FAILED ? 'Failed' : 'Pending';
  return { status, order: final || order, paymentId: final?.paymentId, utr: final?.utr || '', payerVpa: final?.payerVpa || '', message: status === 'Paid' ? `Payment received.${paidVia(final) ? ` ${paidVia(final)}.` : ''}` : status === 'Failed' ? 'The payment did not go through. You were not charged - please try again.' : 'The bank has not confirmed yet. We will mark it paid as soon as it does.' };
}

/** The server settles the payment (webhook, or its reconcile job). Watch the order for a short while; if it is still open, hand over to the "checking" screen. */
async function waitForServer(gw, order, seconds = 12) {
  const end = Date.now() + seconds * 1000; let o = order;
  while (Date.now() < end) {
    try { o = await gw.getOrder(order.orderId); } catch { /* a read that failed: try again */ }
    if (['Paid', 'Failed', 'Expired'].includes(o.status)) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return resultOf(o);
}
export const resultOf = (o) => (o.status === 'Paid' ? { status: 'Paid', order: o, paymentId: o.paymentId, message: 'Payment received.' }
  : o.status === 'Failed' ? { status: 'Failed', order: o, message: o.note || 'The payment did not go through. You were not charged - you can try again.' }
  : o.status === 'Expired' ? { status: 'Expired', order: o, message: 'This payment was not completed in time. If money left your account the bank returns it, or it is confirmed here shortly - quote the order number to the office.' }
  : { status: 'Pending', order: o, checking: true, message: 'The bank has not confirmed yet.' });

/** The server's price for bills (late fees included), for showing the payer the exact amount before they pay. null when the browser demo prices it itself. */
export async function quoteBills(refs, extra = {}) { const g = activeGateway(); return serverDecides() && g.quote ? g.quote({ purpose: 'due', refs, ...extra }).catch(() => null) : null; }   // a back end that prices bills itself

/** Re-reads an order (the "we are checking your payment" screen). */
const announce = (purpose) => { if (typeof window !== 'undefined') for (const c of CHANGES[purpose] || [COLLECTIONS.DUES, COLLECTIONS.LEDGER]) window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: c } })); };
export async function checkOrder(orderId) { const r = resultOf(await activeGateway().getOrder(orderId)); if (r.status === 'Paid') announce(r.order?.purpose); return r; }

/** Simulator only: the bank finally confirms a pending payment. */
export async function confirmPending(orderId) {
  const gw = activeGateway(); const order = await gw.getOrder(orderId);
  if (!order || !gw.buildWebhook) return { ok: false };
  const ev = await gw.buildWebhook(order, OUTCOME.SUCCESS, order.method, order.payerVpa ? { payerVpa: order.payerVpa, app: order.upiApp } : null);
  const r = await receiveWebhook(gw, ev.raw, ev.signature);
  announce(order.purpose);
  return r;
}

// ---- settlers: what each kind of payment does once the webhook is verified ----
registerSettler('due', async (order, ev) => {
  // a UPI payment is recorded by its UTR (what the bank statement shows), with the payer's UPI ID
  const paid = await settleDues({ dueIds: order.refs, unit: order.unit, useCredit: !!order.meta?.useCredit, mode: ev.method || 'Online', reference: ev.utr ? `UTR ${ev.utr}${ev.payerVpa ? ` · ${ev.payerVpa}` : ''}` : ev.paymentId, paidBy: order.payer });
  if (paid.length) notify({ event: 'payment_made', title: `Payment received · ${order.unit}`, body: `${paid.length} bill(s) paid online on ${dmy(ev.at.slice(0, 10))}. Reference ${ev.utr ? `UTR ${ev.utr} (${ev.payerVpa || 'UPI'})` : ev.paymentId}.`, link: '#/billing', toRoleIds: ['treasurer'], by: order.payer }).catch(() => {});
});
registerSettler('booking', async () => { /* the booking is created right after a Paid result and carries the payment id; nothing to settle here */ });
// 'donation' is registered by lib/payments.js (it owns the pledge / receipt rules)
