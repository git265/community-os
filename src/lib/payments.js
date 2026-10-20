import { upiQrEnabled } from './region/paymentModes.js';
// Payments for any event/collection (cultural events today; maintenance dues, facility fees later).
// 1. UPI deep link + QR: works offline, no gateway needed. The payer scans the QR (or taps "Open UPI app" on a phone),
//    pays, then enters the UPI reference; the committee verifies it against the bank statement and issues the receipt.
// 2. Gateway adapter: `GATEWAYS` is the extension point. The demo gateway is simulated in the browser. A real one
//    (Razorpay / PayU / Cashfree) creates an order on the server and confirms through a signed webhook - the UI
//    calls the same `payOnline()` either way.
import { logEvent } from './audit/auditLog.js';
import QRCode from 'qrcode';
import { storage } from './storage/index.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { recomputeEventTotals, nextReceiptNo } from './culturalServer.js';
import { notify } from './notify.js';

export const GATEWAY_NONE = 'None (UPI QR only)';
export const GATEWAY_DEMO = 'Demo gateway (simulated)';

/** upi://pay link per the NPCI UPI linking spec. Amount optional (payer types it). */
export function upiLink({ upiId, payee, amount, note, ref }) {
  if (!upiId) return '';
  const p = [`pa=${encodeURIComponent(upiId.trim())}`];
  if (payee) p.push(`pn=${encodeURIComponent(payee)}`);
  const a = Number(amount);
  if (a > 0) p.push(`am=${a.toFixed(2)}`);
  p.push('cu=INR');
  if (note) p.push(`tn=${encodeURIComponent(String(note).slice(0, 50))}`);
  if (ref) p.push(`tr=${encodeURIComponent(String(ref).replace(/[^A-Za-z0-9]/g, '').slice(0, 35))}`);
  return `upi://pay?${p.join('&')}`;
}

export const validUpiId = (s) => /^[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9.-]{1,}$/.test(String(s || '').trim());

export function qrDataUrl(text) {
  return QRCode.toDataURL(text, { margin: 1, width: 260, errorCorrectionLevel: 'M' });
}

/** Every online payment goes through the community's payment gateway (Setup → Payments); there is no per-event switch any more. */
export const gatewayOf = () => GATEWAY_DEMO;

/** Gateway success handler. For the demo gateway this is the whole "payment"; a real gateway calls the same
 *  server-side step from its webhook. Marks the pledge Received, issues the receipt and tells the payer. */
export async function payOnline(donationId, ev, { by = '', gatewayRef: paidRef = '' } = {}) {
  const d = await storage.get(C.CULTURAL_DONATIONS, donationId);
  if (!d) throw new Error('Pledge not found');
  if (d.status === 'Received') return d;
  const receiptNo = d.receiptNo || await nextReceiptNo(ev);
  const gatewayRef = paidRef || `DEMO${Date.now().toString(36).toUpperCase()}`;
  const out = await storage.put(C.CULTURAL_DONATIONS, { ...d, status: 'Received', receiptNo, mode: 'Online (demo)', reference: d.reference || gatewayRef, gatewayRef, date: new Date().toISOString().slice(0, 10), lastUpdatedBy: 'System · payment gateway (demo)' });
  await recomputeEventTotals(ev.id);
  logEvent({ who: by || 'Online payment (demo gateway)', what: 'Cultural Donations', action: 'Update', recordId: d.id, recordShortId: d.shortId || '', summary: `Online payment of ₹${Number(d.amount).toLocaleString('en-IN')} received · receipt ${receiptNo}`, changes: [{ field: 'status', label: 'Status', from: d.status, to: 'Received' }] });
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.CULTURAL_DONATIONS } }));
  notify({ event: 'cultural', title: `Receipt ${receiptNo} · ${ev.name}`, body: `Payment of ₹${Number(d.amount).toLocaleString('en-IN')} received online (demo). Receipt ${receiptNo}.`, link: '#/cultural', toUnit: d.unit, by }).catch(() => {});
  return out || { ...d, status: 'Received', receiptNo };
}

/** Payer says "I've paid": stores the UPI reference and a claim time (status stays Pledged until the committee verifies). */
export async function claimPayment(donation, utr, save, ev, by = '') {
  const out = await save({ ...donation, reference: utr, mode: upiQrEnabled() ? 'UPI' : 'Bank transfer', paymentClaimedAt: new Date().toISOString() });
  if (out) notify({ event: 'cultural', title: `Payment to verify · ${ev.name}`, body: `${donation.donor}${donation.unit ? ` (${donation.unit})` : ''} reports paying ₹${Number(donation.amount).toLocaleString('en-IN')} by UPI, ref ${utr}. Verify it in your bank statement, then Mark received.`, link: '#/cultural', toRoleIds: ['committee_cultural', 'president', 'general_secretary', 'treasurer'], by }).catch(() => {});
  return out;
}

// Online donation payments finish here once the gateway's verified webhook arrives (also when a "pending" payment is confirmed later).
import { registerSettler } from './payments/index.js';
registerSettler('donation', async (order, evt) => {
  const d = await storage.get(C.CULTURAL_DONATIONS, order.refs[0]);
  const ev = d && await storage.get(C.CULTURAL_EVENTS, d.eventId);
  if (d && ev) await payOnline(d.id, { ...ev, gateway: GATEWAY_DEMO }, { by: order.payer, gatewayRef: evt.paymentId });
});
